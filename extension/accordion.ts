/*
 * accordion.ts — the pi extension half of the Accordion live link.
 *
 * "GUI drives, extension is thin": this extension makes NO folding decisions. On
 * every `context` hook it linearizes pi's outgoing messages into blocks, streams
 * the new ones to the Accordion GUI over a WebSocket, awaits a fold plan, and
 * applies it to the messages pi is about to send. The GUI runs the engine.
 *
 * Connection model: "pull" (see docs/adr/0001-pi-live-integration.md). Each pi
 * session binds an EPHEMERAL loopback port and advertises itself by writing a
 * descriptor to ~/.accordion/sessions/<id>.json (see ../app/src/lib/live/registry).
 * The app watches that directory, lists every live session, and connects to the
 * one the user picks. `/accordion` writes a one-shot focus request so the app
 * foregrounds itself on this session. The extension never launches the app.
 *
 * Safety:
 *   • No GUI connected, or the plan reply times out → pass messages through
 *     UNMODIFIED. We never corrupt context.
 *   • pi's native /compact is suppressed ONLY while the GUI is attached.
 *   • The shared mapping (linearize/applyPlan) carries the provider-safety rules
 *     and a coarse "never fold the newest messages" backstop.
 *
 * Milestone 1: the GUI replies with an empty plan, so this never alters a model
 * call — it only proves the loop and powers the live view.
 *
 * Register it in ~/.pi/agent/settings.json:
 *   { "extensions": ["<repo>/extension/accordion.ts"] }
 */
import { WebSocketServer, type WebSocket } from "ws";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { linearize, applyPlan, type PiMessage } from "../app/src/lib/live/mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, type FoldOp, type ServerMessage, type StreamMessage } from "../app/src/lib/live/protocol";
import {
	REGISTRY_PROTOCOL,
	REGISTRY_DIR,
	SESSIONS_SUBDIR,
	FOCUS_FILE,
	HEARTBEAT_INTERVAL_MS,
	type SessionEntry,
	type FocusRequest,
} from "../app/src/lib/live/registry";

const REQUEST_TIMEOUT_MS = 250; // how long pi waits on the GUI before passing through

// Base dir is overridable for tests (smoke.mjs) so they don't touch the real home.
const HOME = process.env.ACCORDION_HOME || os.homedir();
const REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
const SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
const FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);

export default function accordionLive(pi: ExtensionAPI): void {
	let wss: WebSocketServer | null = null;
	let client: WebSocket | null = null; // the GUI (one driver at a time in M1)
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", format: "pi" as const };

	let sentCount = 0; // blocks already streamed to the current client
	let reqSeq = 0;
	let epoch = 0; // bumped on every new GUI connection; invalidates in-flight requests
	const pending = new Map<number, (ops: FoldOp[]) => void>();
	// Last messages snapshot seen at `context` or `agent_end`. Used by the
	// `message_end` committed-streaming path to build a full array for linearize
	// without losing global turn/order numbering (see Phase 3 in ADR 0003).
	let lastMessages: PiMessage[] = [];
	// Messages that have FINISHED since the last `context`/`agent_end` snapshot, in
	// finish order. In a tool loop the assistant message and its tool result both end
	// before the next `context` fires; we must accumulate ALL of them (not just the
	// latest) so `linearize([...lastMessages, ...pendingSince])` carries correct global
	// turn/order and never drops or mis-numbers the earlier message. Reset whenever an
	// authoritative snapshot (`context`/`agent_end`) supersedes it.
	let pendingSince: PiMessage[] = [];
	// Most recent ExtensionContext seen on any hook. Captured so the WS connection
	// handler (which gets no ctx of its own) can read pi's CURRENT session history
	// directly at attach time — the authoritative way to populate the view for a
	// session that already has turns (especially a RESUMED session, where no
	// `context`/`agent_end` has fired yet so `lastMessages` would still be empty).
	let latestCtx: ExtensionContext | null = null;

	// ── discovery (registry) state ──────────────────────────────────────────────
	let port = 0; // actual ephemeral port, filled once the server is listening
	let startedAt = 0;
	let model = "";
	let tokens: number | null = null;
	let contextWindow: number | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const attached = (): boolean => !!client && client.readyState === 1; /* OPEN */

	/** Resolve every outstanding request as passthrough (used on connect-swap / shutdown). */
	function flushPending(): void {
		for (const resolve of pending.values()) resolve([]);
		pending.clear();
	}

	function send(ws: WebSocket, m: ServerMessage): void {
		try {
			ws.send(JSON.stringify(m));
		} catch {
			/* socket gone */
		}
	}

	/** Send a stream lifecycle frame if and only if a GUI is currently attached. */
	function sendStream(frame: StreamMessage): void {
		const ws = client;
		if (!ws || ws.readyState !== 1) return;
		send(ws, frame);
	}

	// ── registry file: advertise this session for the app to discover ───────────
	function buildEntry(): SessionEntry {
		return {
			registryProtocol: REGISTRY_PROTOCOL,
			protocolVersion: PROTOCOL_VERSION,
			sessionId,
			port,
			pid: process.pid,
			cwd: meta.cwd,
			title: meta.title,
			model,
			tokens,
			contextWindow,
			startedAt,
			heartbeatAt: Date.now(),
		};
	}

	/** Atomic write (temp + rename) so the app never reads a half-written file. */
	function writeEntry(): void {
		if (!port || !sessionId) return;
		try {
			fs.mkdirSync(SESSIONS_DIR, { recursive: true });
			const target = path.join(SESSIONS_DIR, `${sessionId}.json`);
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(buildEntry()));
			fs.renameSync(tmp, target);
		} catch {
			/* discovery is best-effort; never let it break a session */
		}
	}

	function deleteEntry(): void {
		if (!sessionId) return;
		try {
			fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
		} catch {
			/* already gone */
		}
	}

	/** /accordion writes a one-shot request for the (already-open) app to focus us. */
	function writeFocusRequest(): void {
		if (!sessionId) return;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			const req: FocusRequest = { sessionId, ts: Date.now() };
			const tmp = `${FOCUS_PATH}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(req));
			fs.renameSync(tmp, FOCUS_PATH);
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Read pi's CURRENT session history as an AgentMessage[] (the same shape the
	 * `context` hook delivers), straight from the session manager. This is the
	 * authoritative source for "what's in this session right now" — it works even
	 * when no hook has fired yet (a freshly resumed/loaded session), which is the
	 * exact case where `lastMessages` is still empty.
	 *
	 * Prefer `buildSessionContext()` — pi's own resolver (tree traversal from the
	 * current leaf; collapses compaction/branches to exactly what would go to the
	 * model). It lives on SessionManager but is omitted from the ReadonlySessionManager
	 * type, so we reach it via a guarded cast. Fall back to reconstructing from the
	 * active branch's message entries (leaf→root, so reverse to chronological).
	 * Best-effort throughout: any failure yields [] and the caller keeps its cache.
	 */
	function readSessionMessages(c: ExtensionContext | null): PiMessage[] {
		if (!c) return [];
		const sm = c.sessionManager as unknown as {
			buildSessionContext?: () => { messages?: unknown };
			getBranch?: (fromId?: string) => Array<{ type: string; message?: unknown }>;
		} | undefined;
		if (!sm) return [];
		try {
			const sc = sm.buildSessionContext?.();
			if (sc && Array.isArray(sc.messages)) return sc.messages as PiMessage[];
		} catch {
			/* fall through to the branch reconstruction */
		}
		try {
			const branch = sm.getBranch?.() ?? [];
			const msgs = branch.filter((e) => e.type === "message" && e.message).map((e) => e.message as PiMessage);
			msgs.reverse(); // getBranch walks leaf→root; the view wants chronological order
			return msgs;
		} catch {
			return [];
		}
	}

	/** Pull model id + live usage off the hook context (best-effort). */
	function refreshFromCtx(ctx: ExtensionContext): void {
		try {
			const m = ctx.getModel?.();
			if (m?.id) {
				model = m.id;
				meta.model = m.id;
				if (typeof m.contextWindow === "number") contextWindow = m.contextWindow;
			}
			const u = ctx.getContextUsage?.();
			if (u) {
				tokens = u.tokens;
				if (typeof u.contextWindow === "number") contextWindow = u.contextWindow;
			}
		} catch {
			/* optional APIs */
		}
	}

	function startServer(): void {
		if (wss) return;
		try {
			// port 0 ⇒ OS assigns a free ephemeral port (one server per pi session).
			wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
				const addr = wss?.address();
				if (addr && typeof addr === "object") {
					port = addr.port;
					writeEntry(); // advertise immediately, now that the port is known
					if (!heartbeat) {
						heartbeat = setInterval(writeEntry, HEARTBEAT_INTERVAL_MS);
						heartbeat.unref?.(); // never keep the process alive for a heartbeat
					}
				}
			});
		} catch {
			wss = null;
			return;
		}
		wss.on("connection", (ws: WebSocket) => {
			flushPending(); // supersede any prior GUI: its in-flight requests pass through
			client = ws;
			epoch++;
			sentCount = 0; // re-sync the whole context to the freshly-connected GUI
			reqSeq = 0;
			send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, meta });

			// Flush existing history IMMEDIATELY on attach. Without this, a session that
			// already has turns stays empty in the app until the next hook fires — and the
			// only hook that streams the backlog is `context`, which fires before the next
			// model call (i.e. when the user sends their next message). So `/accordion` in a
			// session with history would show nothing until the first message.
			//
			// Read the history STRAIGHT FROM THE SESSION at attach time (not from the cached
			// `lastMessages`): on a resumed/loaded session no hook has fired yet, so the cache
			// is empty — but the session manager already holds the full conversation. We adopt
			// that read as the new baseline so the flush, the message_end dedup, and the cursor
			// all agree. If the live read is empty (e.g. a brand-new session, or no session
			// manager in tests) we fall back to whatever the hooks have cached.
			const live = readSessionMessages(latestCtx);
			if (live.length) lastMessages = live;
			// VIEW-ONLY full sync: folding may legally happen only at `context`, so (like the
			// agent_end/message_end paths) we do NOT await or apply a plan here.
			const backlog = linearize(lastMessages);
			if (backlog.length) {
				send(ws, { type: "sync", reqId: ++reqSeq, full: true, blocks: backlog });
				sentCount = backlog.length; // cursor now matches what the GUI holds
			}
			ws.on("message", (data: Buffer) => {
				if (ws !== client) return; // ignore stray messages from a superseded GUI
				let msg: any;
				try {
					msg = JSON.parse(data.toString());
				} catch {
					return;
				}
				if (msg?.type === "plan" && typeof msg.reqId === "number") {
					const resolve = pending.get(msg.reqId);
					if (resolve) {
						pending.delete(msg.reqId);
						resolve(Array.isArray(msg.ops) ? msg.ops : []);
					}
				}
			});
			const drop = () => {
				if (client === ws) client = null;
			};
			ws.on("close", drop);
			ws.on("error", drop);
		});
		wss.on("error", () => {
			/* e.g. unexpected bind failure — run headless (passthrough) */
			wss = null;
		});
	}

	/** Send a sync and await the GUI's plan; resolves [] on timeout, null if unsent. */
	function requestPlan(reqId: number, full: boolean, blocks: ReturnType<typeof linearize>): Promise<FoldOp[] | null> {
		return new Promise((resolve) => {
			const ws = client;
			if (!ws || ws.readyState !== 1) return resolve(null);
			const timer = setTimeout(() => {
				if (pending.has(reqId)) {
					pending.delete(reqId);
					resolve([]); // delivered but no reply in time → passthrough
				}
			}, REQUEST_TIMEOUT_MS);
			pending.set(reqId, (ops) => {
				clearTimeout(timer);
				resolve(ops);
			});
			send(ws, { type: "sync", reqId, full, blocks });
		});
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		sessionId = `s-${process.pid}-${Date.now()}`;
		sentCount = 0;
		pendingSince = [];
		// Seed the cache from the session itself. For a fresh session this is []; for a
		// RESUMED/loaded session (reason "resume"/"startup"/"fork") it is the full prior
		// conversation, which would otherwise stay invisible until the first `context` hook
		// (i.e. the user's next message) — the bug. Reading here means an attach that lands
		// before any turn still has a correct baseline to flush.
		lastMessages = readSessionMessages(ctx);
		startedAt = Date.now();
		try {
			meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", format: "pi" };
		} catch {
			/* keep defaults */
		}
		refreshFromCtx(ctx); // model may be known already
		startServer();
		try {
			ctx.ui.setStatus("accordion", ctx.ui.theme.fg("accent", "\u{1FA97} accordion"));
		} catch {
			/* status API optional */
		}
	});

	// ── ghost layer: forward stream lifecycle frames (Phase 4, ADR 0003) ─────────
	// `message_update` fires for every token delta — we deliberately drop those.
	// We forward ONLY the *_start / *_end / error lifecycle transitions, which are
	// sufficient to drive a CSS pulse animation. The token-delta firehose is consumed
	// and discarded at the source; zero per-token frames cross the wire.
	//
	// View-only: this handler never touches a model call, never reads lastMessages,
	// and never registers in `pending`. It is purely presentational.
	//
	// Kind mapping: text_start/end → "text", thinking_start/end → "thinking",
	//               toolcall_start/end → "tool_call". error → abort sweep.
	pi.on("message_update", (event: any) => {
		const ws = client;
		if (!ws || ws.readyState !== 1) return;

		const ev = event?.assistantMessageEvent;
		if (!ev || typeof ev.type !== "string") return;

		const t = ev.type as string;
		const ci: number = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;

		// Map pi's event type to ghost kind + phase.
		// start events → spawn / refresh a ghost.
		if (t === "text_start") {
			sendStream({ type: "stream", phase: "start", kind: "text", contentIndex: ci });
		} else if (t === "thinking_start") {
			sendStream({ type: "stream", phase: "start", kind: "thinking", contentIndex: ci });
		} else if (t === "toolcall_start") {
			sendStream({ type: "stream", phase: "start", kind: "tool_call", contentIndex: ci });
		}
		// end events → resolve a ghost.
		else if (t === "text_end") {
			sendStream({ type: "stream", phase: "end", kind: "text", contentIndex: ci });
		} else if (t === "thinking_end") {
			sendStream({ type: "stream", phase: "end", kind: "thinking", contentIndex: ci });
		} else if (t === "toolcall_end") {
			sendStream({ type: "stream", phase: "end", kind: "tool_call", contentIndex: ci });
		}
		// error / aborted → abort sweep: clear all ghosts (contentIndex -1 = "all").
		// On an abnormal stream end NO committed block is coming, so the ghost must
		// vanish immediately (ADR 0003 invariant #3), not wait for the message_end sweep.
		else if (t === "error" || t === "aborted") {
			sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		}
		// `done` (clean stream end) is intentionally NOT swept here: the message_end hook
		// fires immediately after with the committed blocks and runs its own sweep, so
		// resolving here would only risk a sub-tick gap. All `*_delta` events (the token
		// firehose) are silently dropped — we never forward token deltas over the wire.
	});

	// ── the loop: stream context, await a plan, apply it ────────────────────────
	// Returning `undefined` keeps pi's original messages (documented passthrough);
	// only an explicit `{ messages }` replaces them. Every passthrough path below
	// returns undefined, so we never alter a model call without a plan.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		const myEpoch = epoch;
		// Refresh model/usage in memory only — NO disk I/O on the model-call critical
		// path. The 5s heartbeat persists these to the registry for the sidebar.
		refreshFromCtx(ctx);
		// Cache the snapshot so `message_end` can build a globally-correct full array.
		// Note: pi passes a structuredClone here (runner.js emitContext), so this is
		// always a safe point-in-time snapshot of messages going INTO the model call.
		// This snapshot is authoritative, so any messages we accumulated since the last
		// one are now subsumed by it — drop them.
		lastMessages = event.messages as unknown as PiMessage[];
		pendingSince = [];
		const all = linearize(lastMessages);
		if (!attached()) return; // no GUI → pass through untouched

		const fresh = all.slice(sentCount);
		const reqId = ++reqSeq;
		const full = sentCount === 0;
		const ops = await requestPlan(reqId, full, fresh);
		if (ops === null) return; // couldn't deliver → pass through, don't advance
		if (epoch !== myEpoch) return; // GUI reconnected mid-flight → don't apply/advance
		sentCount = all.length; // sync delivered → advance the stream cursor
		if (ops.length === 0) return; // empty plan (Milestone 1) → pass through

		return { messages: applyPlan(event.messages as unknown as PiMessage[], ops) as unknown as AgentMessage[] };
	});

	// ── committed streaming: push blocks the instant pi finishes a message ──────
	// `context` only fires BEFORE a model call (messages going IN); `agent_end` fires
	// only once at loop end. `message_end` fires the moment each message is finalized
	// — including assistant replies mid-tool-loop — so the GUI sees new blocks
	// immediately rather than waiting for the next turn.
	//
	// Implementation path: SAFE FALLBACK (not the simple array-cache path).
	// Evidence: pi's runner.js emitContext() calls structuredClone() before passing
	// the array to the `context` extension hook, so `lastMessages` cached there is a
	// snapshot of messages BEFORE the model call — it does NOT include the reply that
	// `message_end` is delivering. We therefore build a synthetic full array,
	// `[...lastMessages, ...pendingSince]`, where `pendingSince` accumulates EVERY
	// message finished since that snapshot (in finish order). Linearizing the whole
	// thing gives correct global turn/order numbering.
	//
	// Why accumulate, not just append the latest: in a tool loop the assistant message
	// AND its tool result both finish before the next `context` fires. Appending only
	// the latest to a stale `lastMessages` would drop the earlier message — the later
	// one would then be mis-numbered or (because the cursor already counted the dropped
	// one) skipped entirely until the next `context` caught up. Accumulating preserves
	// both with correct numbering and keeps the cursor aligned.
	//
	// Hazard guarded: a message already represented in `lastMessages` (e.g. a user
	// message that went through the context snapshot) or already in `pendingSince` is
	// NOT added again — double-counting would over-advance `sentCount` and open a gap
	// at the next `context` that the GUI's dedup cannot fix.
	//
	// View-only: no reqId registered in `pending`; folding may only happen at `context`.
	// The `agent_end` handler below remains the loop-end backstop — with dedup it is
	// harmless; it catches anything missed (e.g. if message_end fired with no GUI).
	pi.on("message_end", (event) => {
		const ws = client;
		if (!ws || ws.readyState !== 1) return; // no GUI → nothing to push

		// Guaranteed teardown (invariant #2, ADR 0003): sweep all active ghosts as a
		// backstop. Any ghost not already resolved by its own *_end frame is cleared
		// here so no ghost can outlive the message. Sent BEFORE the sync so the GUI
		// clears ghost placeholders exactly when it receives the real committed blocks.
		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });

		const msg = event.message as unknown as PiMessage;

		// Add to `pendingSince` only if NONE of the durable ids this message emits are
		// already represented — in the authoritative snapshot or already accumulated
		// this turn. We dedup on the message's FULL id set, not a single probe id:
		//   • a probe of only part 0 misses a message whose leading part is empty
		//     (linearize drops empty non-result parts, so `:p0` is never emitted), and
		//   • a reference check (`pendingSince.includes(msg)`) misses a re-fired message
		//     delivered as a different object with the same durable id.
		// Either escape would double-count and over-advance `sentCount`. Durable ids are
		// position-independent, so linearizing each set in isolation is sound (we read
		// only `.id`, never the locally-numbered turn/order).
		const msgIds = new Set(linearize([msg]).map((b) => b.id));
		const baseIds = new Set(linearize(lastMessages).map((b) => b.id));
		const pendIds = new Set(linearize(pendingSince).map((b) => b.id));
		const alreadySeen = [...msgIds].some((id) => baseIds.has(id) || pendIds.has(id));
		if (msgIds.size > 0 && !alreadySeen) pendingSince.push(msg);

		const all = linearize([...lastMessages, ...pendingSince]);
		if (all.length <= sentCount) return; // nothing new since the last sync
		const reqId = ++reqSeq;
		const full = sentCount === 0;
		send(ws, { type: "sync", reqId, full, blocks: all.slice(sentCount) });
		sentCount = all.length; // advance cursor; agent_end and next context will dedup
	});

	// ── live view: push the assistant's reply the moment the loop ends ──────────
	// `context` only fires BEFORE a model call, so it sees messages going IN, never
	// the reply coming OUT — the GUI would otherwise lag one turn (the assistant's
	// response only appears at the next user message). `agent_end` fires when the
	// agent loop finishes and carries the FULL message array, so we stream the new
	// blocks as a VIEW-ONLY sync: we do NOT await or apply a fold plan here (folding
	// may legally happen only at `context`, the one place we can alter the outgoing
	// call). It shares the `sentCount` cursor with `context`, so the deltas never
	// overlap; any plan the GUI replies with carries an unknown reqId and is ignored.
	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		// Cache for next message_end (backstop path); also keeps lastMessages current
		// after the loop ends so any late message_end fires against the right context.
		// This snapshot is authoritative, so drop anything accumulated since the last.
		//
		// Done BEFORE the no-GUI guard ON PURPOSE: even when no app is attached, this
		// keeps the cached history COMPLETE (including this turn's final reply) so that a
		// later `/accordion` attach can flush the whole conversation immediately. `context`
		// alone keeps the cache only up to the last model call — one reply short.
		lastMessages = event.messages as unknown as PiMessage[];
		pendingSince = [];

		const ws = client;
		if (!ws || ws.readyState !== 1) return; // no GUI → cache refreshed, nothing to push

		// Guaranteed teardown (invariant #2, ADR 0003): sweep all active ghosts as a
		// backstop at loop end. Any ghost that survived the message_end sweep (e.g. if
		// the loop ended without a message_end, or a ghost spawned in the last turn) is
		// cleared here so no ghost can survive the agent loop.
		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });

		const all = linearize(lastMessages);
		if (all.length <= sentCount) return; // nothing new since the last sync
		const reqId = ++reqSeq;
		const full = sentCount === 0;
		send(ws, { type: "sync", reqId, full, blocks: all.slice(sentCount) });
		sentCount = all.length; // advance so the next `context` doesn't resend these
	});

	// ── suppress pi's native compaction ONLY while the GUI is driving ───────────
	pi.on("session_before_compact", (_event, ctx: ExtensionContext) => {
		if (attached()) {
			try {
				ctx.ui.notify("Accordion attached — native compaction suppressed.", "info");
			} catch {
				/* ignore */
			}
			return { cancel: true };
		}
		// detached → let pi protect itself
	});

	pi.on("session_shutdown", () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		deleteEntry(); // stop advertising — the app drops our row immediately
		flushPending(); // resolve any awaiting context hook as passthrough
		try {
			client?.close();
		} catch {
			/* ignore */
		}
		try {
			wss?.close();
		} catch {
			/* ignore */
		}
		wss = null;
		client = null;
	});

	// ── /accordion : focus the app on this session + show status ────────────────
	pi.registerCommand("accordion", {
		description: "Focus the Accordion app on this pi session (and show live-link status)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			writeFocusRequest();
			const lines = [
				`Accordion live link — port ${port || "(starting)"}`,
				`GUI: ${attached() ? "ATTACHED — folding driven by the app" : "detached — passthrough, native /compact allowed"}`,
				`blocks streamed this connection: ${sentCount}`,
				`Asked the Accordion app to focus this session (open it if it isn't running).`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// DEFAULT_PORT is retained in protocol.ts only as the browser dev-loop fallback
// (the desktop app discovers ephemeral ports via the registry); reference it so
// the import graph and the constant's purpose stay explicit.
export const BROWSER_FALLBACK_PORT = DEFAULT_PORT;

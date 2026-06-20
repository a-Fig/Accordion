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
 * foregrounds itself on this session; as a convenience, the command can also
 * best-effort launch/reinvoke the desktop app (single-instance keeps that from
 * becoming duplicate windows).
 *
 * Safety:
 *   • No GUI connected, or the plan reply times out → pass messages through
 *     UNMODIFIED. We never corrupt context.
 *   • pi's native /compact is suppressed ONLY while the GUI is attached.
 *   • The shared mapping (linearize/applyPlan) carries the provider-safety rules
 *     (durable-id + kind checks); the engine is the single foldability gate and
 *     never folds a protected block, so no wire-side position backstop is needed.
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
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { linearize, applyPlan, type PiMessage } from "../app/src/lib/live/mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, type FoldOp, type GroupOp, type ServerMessage, type StreamMessage, type UnfoldRequestMessage, type UnfoldResultMessage, type RecallRequestMessage, type RecallContent, type CompleteRequestMessage, type CompleteResultMessage } from "../app/src/lib/live/protocol";

/** The GUI's reply to a sync: in-place fold ops + group-collapse ops (ADR 0006). */
type Plan = { ops: FoldOp[]; groups: GroupOp[] };
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
// Unfold replies arrive during the agent's OWN turn (not on the model-call critical
// path), so a generous wait is fine — the user's next message isn't blocked.
const UNFOLD_TIMEOUT_MS = 2000;
// Recall (ADR 0011) likewise runs during the agent's own turn — a read that echoes the
// folded block's full content back THIS turn — so the same generous wait applies.
const RECALL_TIMEOUT_MS = 2000;

// Base dir is overridable for tests (smoke.mjs) so they don't touch the real home.
const HOME = process.env.ACCORDION_HOME || os.homedir();
const REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
const SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
const FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);

const ACCORDION_APP_FLAG = "accordion-app";
const ACCORDION_APP_ENV = "ACCORDION_APP_PATH";

type LaunchSource = "cli" | "env" | "default";
type LaunchResult =
	| { ok: true; path: string; source: LaunchSource }
	| { ok: false; reason: "explicit-invalid"; path: string; source: Extract<LaunchSource, "cli" | "env"> }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "spawn-failed"; path: string; source: LaunchSource; error: unknown };

function cleanExplicitPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let s = value.trim();
	if (!s) return null;
	// This is still a path-only override, not shell parsing. Stripping one matching
	// quote pair makes common copied Windows paths ("C:\\...\\Accordion.exe") work.
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
	return s;
}

function isLaunchableFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function windowsInstallCandidates(): string[] {
	if (process.platform !== "win32") return [];
	const roots = [
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Accordion"),
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Accordion"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Accordion"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Accordion"),
	].filter((s): s is string => !!s);
	const names = ["Accordion.exe", "app.exe"];
	const out: string[] = [];
	for (const root of roots) for (const name of names) out.push(path.join(root, name));
	return out;
}

function repoAppCandidates(): string[] {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const repo = path.resolve(here, "..");
		const ext = process.platform === "win32" ? ".exe" : "";
		return [
			path.join(repo, "app", "src-tauri", "target", "release", `app${ext}`),
			path.join(repo, "app", "src-tauri", "target", "debug", `app${ext}`),
		];
	} catch {
		return [];
	}
}

function resolveAccordionApp(pi: ExtensionAPI): LaunchResult {
	const flagPath = cleanExplicitPath(pi.getFlag(ACCORDION_APP_FLAG));
	if (flagPath) {
		if (isLaunchableFile(flagPath)) return { ok: true, path: flagPath, source: "cli" };
		return { ok: false, reason: "explicit-invalid", path: flagPath, source: "cli" };
	}

	const envPath = cleanExplicitPath(process.env[ACCORDION_APP_ENV]);
	if (envPath) {
		if (isLaunchableFile(envPath)) return { ok: true, path: envPath, source: "env" };
		return { ok: false, reason: "explicit-invalid", path: envPath, source: "env" };
	}

	for (const candidate of [...windowsInstallCandidates(), ...repoAppCandidates()]) {
		if (isLaunchableFile(candidate)) return { ok: true, path: candidate, source: "default" };
	}
	return { ok: false, reason: "not-found" };
}

async function launchAccordionApp(pi: ExtensionAPI): Promise<LaunchResult> {
	const resolved = resolveAccordionApp(pi);
	if (!resolved.ok) return resolved;
	try {
		const child = spawn(resolved.path, [], { detached: true, stdio: "ignore", shell: false });
		// Catch immediate async launch failures without waiting for the app to boot. Some
		// spawn failures arrive on the child "error" event rather than throwing from spawn().
		return await new Promise<LaunchResult>((resolve) => {
			let settled = false;
			const ok: LaunchResult = { ok: true, path: resolved.path, source: resolved.source };
			const timer = setTimeout(() => finish(ok), 150);
			const finish = (result: LaunchResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("spawn", onSpawn);
				child.unref();
				resolve(result);
			};
			const onSpawn = () => finish(ok);
			const onError = (error: unknown) => finish({ ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error });
			child.once("spawn", onSpawn);
			// Leave this listener installed even after a timeout success; if the OS reports a
			// late error, onError no-ops via `settled` and avoids an unhandled error event.
			child.once("error", onError);
		});
	} catch (error) {
		return { ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error };
	}
}

function launchResultLine(result: LaunchResult | null): { text: string; type: "info" | "warning" } {
	if (!result) return { text: "Accordion focus requested for this session.", type: "info" };
	if (result.ok) return { text: "Launching/focusing Accordion for this session…", type: "info" };
	if (result.reason === "explicit-invalid") {
		const source = result.source === "cli" ? `--${ACCORDION_APP_FLAG}` : ACCORDION_APP_ENV;
		return {
			text: `Accordion focus request written, but ${source} does not point to an executable: ${result.path}`,
			type: "warning",
		};
	}
	if (result.reason === "spawn-failed") {
		return {
			text: `Accordion focus request written, but launching failed for ${result.path}. Set ${ACCORDION_APP_ENV} or --${ACCORDION_APP_FLAG} to the Accordion executable.`,
			type: "warning",
		};
	}
	return {
		text: `Accordion focus request written, but I couldn't find the desktop app. Open Accordion manually, or set ${ACCORDION_APP_ENV} / --${ACCORDION_APP_FLAG}.`,
		type: "warning",
	};
}

export default function accordionLive(pi: ExtensionAPI): void {
	pi.registerFlag(ACCORDION_APP_FLAG, {
		description: "Path to the Accordion desktop app executable for /accordion launch/focus",
		type: "string",
	});

	let wss: WebSocketServer | null = null;
	let client: WebSocket | null = null; // the GUI (one driver at a time in M1)
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", contextWindow: null as number | null, format: "pi" as const };

	let sentCount = 0; // blocks already streamed to the current client
	let reqSeq = 0;
	let epoch = 0; // bumped on every new GUI connection; invalidates in-flight requests
	const pending = new Map<number, (plan: Plan) => void>();
	// Unfold requests: keyed by reqId, resolved when the GUI replies (or null on flush).
	// Deliberately NOT reset on reconnect (unlike reqSeq): a late reply from a superseded
	// GUI can never alias a fresh request's reqId, and flushPending() drains the map anyway.
	let unfoldSeq = 0;
	const pendingUnfold = new Map<number, (res: { restored: Array<{ code: string; kind: string; label: string }>; missing: string[] } | null) => void>();
	// Recall requests (ADR 0011): keyed by reqId, resolved when the GUI replies (or null on
	// flush). Same lifecycle as pendingUnfold; recall is a pure READ (the GUI never mutates
	// fold state) and the result carries the folded block's ORIGINAL full content, echoed to
	// the agent THIS turn.
	let recallSeq = 0;
	const pendingRecall = new Map<number, (res: { restored: RecallContent[]; missing: string[] } | null) => void>();
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
	// Most recent model object, updated both from full hook contexts and the immediate
	// `/model` event. Completion requests use this so `model: "current"` really follows a
	// just-selected model instead of waiting for the next `context` hook to refresh latestCtx.
	let latestModel: any = null;

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
		for (const resolve of pending.values()) resolve({ ops: [], groups: [] });
		pending.clear();
		// In-flight unfold requests (if any) must also be resolved. null signals "not
		// attached" — the tool returns a safe "did not respond" message to the agent.
		for (const resolve of pendingUnfold.values()) resolve(null);
		pendingUnfold.clear();
		// Same for in-flight recall reads — resolve as null so the tool reports cleanly.
		for (const resolve of pendingRecall.values()) resolve(null);
		pendingRecall.clear();
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

	/** /accordion writes a one-shot request for the app to focus us once it is open. */
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
		let sm: {
			buildSessionContext?: () => { messages?: unknown };
			getBranch?: (fromId?: string) => Array<{ type: string; message?: unknown }>;
		} | undefined;
		try {
			sm = c.sessionManager as unknown as typeof sm;
		} catch {
			return [];
		}
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

	/** Adopt a model's id + context window into the live + meta state (best-effort). */
	function applyModel(m: { id?: string; contextWindow?: number } | undefined): void {
		if (!m) return;
		latestModel = m;
		if (m.id) {
			model = m.id;
			meta.model = m.id;
		}
		// Set the window independent of `id` — some providers surface a usable
		// contextWindow even when id is momentarily absent (the registry showed this).
		if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
			contextWindow = m.contextWindow;
			meta.contextWindow = m.contextWindow;
		}
	}

	/** Pull model id + live usage off the hook context (best-effort). */
	function refreshFromCtx(ctx: ExtensionContext): void {
		try {
			applyModel(ctx.model as { id?: string; contextWindow?: number } | undefined);
			const u = ctx.getContextUsage?.();
			if (u) {
				tokens = u.tokens;
				if (typeof u.contextWindow === "number") {
					contextWindow = u.contextWindow;
					meta.contextWindow = u.contextWindow;
				}
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
				send(ws, { type: "sync", reqId: ++reqSeq, full: true, blocks: backlog, contextWindow });
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
						resolve({ ops: Array.isArray(msg.ops) ? msg.ops : [], groups: Array.isArray(msg.groups) ? msg.groups : [] });
					}
				}
				if (msg?.type === "unfoldResult" && typeof msg.reqId === "number") {
					const resolve = pendingUnfold.get(msg.reqId);
					if (resolve) {
						pendingUnfold.delete(msg.reqId);
						resolve({
							restored: Array.isArray(msg.restored) ? msg.restored : [],
							missing: Array.isArray(msg.missing) ? msg.missing : [],
						});
					}
				}
				if (msg?.type === "recallResult" && typeof msg.reqId === "number") {
					const resolve = pendingRecall.get(msg.reqId);
					if (resolve) {
						pendingRecall.delete(msg.reqId);
						resolve({
							restored: Array.isArray(msg.restored) ? msg.restored : [],
							missing: Array.isArray(msg.missing) ? msg.missing : [],
						});
					}
				}
				if (msg?.type === "completeRequest" && typeof msg.reqId === "number") {
					// Out-of-band: fire async and NEVER block the message handler or any hook.
					// Dynamic import so the module is resolved lazily — at pi load time pi's jiti
					// alias table maps "@earendil-works/pi-ai" to its bundled copy; the smoke test
					// never triggers a real model call so it never reaches this import.
					const req = msg as CompleteRequestMessage;
					const capturedWs = ws;
					void (async () => {
						const reply = (r: CompleteResultMessage): void => {
							// Only send if this GUI is still the active client (reconnect guard).
							if (capturedWs === client && capturedWs.readyState === 1) send(capturedWs, r);
						};
						// Validate prompt before doing any async work.
						if (typeof req.prompt !== "string" || req.prompt.length === 0) {
							reply({ type: "completeResult", reqId: req.reqId, ok: false, error: "missing or empty prompt" });
							return;
						}
						try {
							const ctx = latestCtx;
							const m = latestModel ?? ctx?.model;
							if (!ctx || !m) {
								reply({ type: "completeResult", reqId: req.reqId, ok: false, error: "no model available" });
								return;
							}
							const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
							if (!auth.ok) {
								reply({ type: "completeResult", reqId: req.reqId, ok: false, error: `could not resolve API key: ${(auth as any).error ?? "unknown"}` });
								return;
							}
							const { complete } = await import("@earendil-works/pi-ai");
							// Pass system only if it's a string; treat as optional.
							const context = {
								...(typeof req.system === "string" ? { systemPrompt: req.system } : {}),
								messages: [{ role: "user" as const, content: req.prompt, timestamp: Date.now() }],
							};
							// Clamp requested maxOutputTokens to the model's own output ceiling
							// so a conductor requesting more than the model allows can't trigger a provider
							// rejection; the model still hard-caps generation (truncates at the limit).
							let maxTokens: number | undefined;
							if (typeof req.maxOutputTokens === "number" && req.maxOutputTokens > 0) {
								const modelCeiling = typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : undefined;
								maxTokens = modelCeiling !== undefined ? Math.min(req.maxOutputTokens, modelCeiling) : req.maxOutputTokens;
							}
							const result = await complete(m, context, {
								apiKey: auth.apiKey,
								headers: auth.headers,
								...(maxTokens !== undefined ? { maxTokens } : {}),
							});
							// Concatenate ALL text parts in order (a multi-part response must not be
							// truncated to the first part only). Defensively guard non-array content
							// and missing/non-string part text.
							let text = "";
							if (Array.isArray(result.content)) {
								text = result.content
									.filter((p: any) => p?.type === "text")
									.map((p: any) => (typeof p?.text === "string" ? p.text : ""))
									.join("");
							}
							reply({
								type: "completeResult",
								reqId: req.reqId,
								ok: true,
								text,
								model: result.model,
								inputTokens: typeof result.usage?.input === "number" ? result.usage.input : undefined,
								outputTokens: typeof result.usage?.output === "number" ? result.usage.output : undefined,
							});
						} catch (err: unknown) {
							const errMsg = err instanceof Error ? err.message : String(err);
							reply({ type: "completeResult", reqId: req.reqId, ok: false, error: errMsg });
						}
					})();
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

	/** Send a sync and await the GUI's plan; resolves an empty plan on timeout, null if unsent. */
	function requestPlan(reqId: number, full: boolean, blocks: ReturnType<typeof linearize>): Promise<Plan | null> {
		return new Promise((resolve) => {
			const ws = client;
			if (!ws || ws.readyState !== 1) return resolve(null);
			const timer = setTimeout(() => {
				if (pending.has(reqId)) {
					pending.delete(reqId);
					resolve({ ops: [], groups: [] }); // delivered but no reply in time → passthrough
				}
			}, REQUEST_TIMEOUT_MS);
			pending.set(reqId, (plan) => {
				clearTimeout(timer);
				resolve(plan);
			});
			send(ws, { type: "sync", reqId, full, blocks, contextWindow });
		});
	}

	/** Ask the GUI to restore folded blocks by their codes; mirrors requestPlan in structure. */
	function requestUnfold(codes: string[]): Promise<{ restored: Array<{ code: string; kind: string; label: string }>; missing: string[] } | null> {
		return new Promise((resolve) => {
			const ws = client;
			if (!ws || ws.readyState !== 1) return resolve(null);
			const reqId = ++unfoldSeq;
			// Generous timeout: this runs during the agent's own turn, not on the critical
			// model-call path, so 2 s gives the GUI time to process and reply.
			const timer = setTimeout(() => {
				if (pendingUnfold.has(reqId)) { pendingUnfold.delete(reqId); resolve(null); }
			}, UNFOLD_TIMEOUT_MS);
			pendingUnfold.set(reqId, (res) => { clearTimeout(timer); resolve(res); });
			send(ws, { type: "unfoldRequest", reqId, codes } as UnfoldRequestMessage);
		});
	}

	/**
	 * Ask the GUI for the ORIGINAL full content of folded blocks by their codes (ADR 0011).
	 * Mirrors requestUnfold in structure, but the GUI replies with the blocks' full content
	 * (a pure READ — fold state is never changed). The tool echoes that content to the agent
	 * THIS turn. Resolves null if unsent (no GUI) or on timeout.
	 */
	function requestRecall(codes: string[]): Promise<{ restored: RecallContent[]; missing: string[] } | null> {
		return new Promise((resolve) => {
			const ws = client;
			if (!ws || ws.readyState !== 1) return resolve(null);
			const reqId = ++recallSeq;
			const timer = setTimeout(() => {
				if (pendingRecall.has(reqId)) { pendingRecall.delete(reqId); resolve(null); }
			}, RECALL_TIMEOUT_MS);
			pendingRecall.set(reqId, (res) => { clearTimeout(timer); resolve(res); });
			send(ws, { type: "recallRequest", reqId, codes } as RecallRequestMessage);
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
			meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", contextWindow: null, format: "pi" };
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
		const plan = await requestPlan(reqId, full, fresh);
		if (plan === null) return; // couldn't deliver → pass through, don't advance
		if (epoch !== myEpoch) return; // GUI reconnected mid-flight → don't apply/advance
		sentCount = Math.max(sentCount, all.length); // advance cursor; never rewind (a message_end during the await may have advanced it further)
		if (plan.ops.length === 0 && plan.groups.length === 0) return; // empty plan → pass through

		return { messages: applyPlan(event.messages as unknown as PiMessage[], plan.ops, plan.groups) as unknown as AgentMessage[] };
	});

	// ── model swap: keep the GUI's context window (and budget) in lockstep ───────
	// `/model` fires `model_select` immediately, carrying the NEW model. Adopt its
	// context window and push it to the GUI right away (a view-only sync with no
	// blocks) so the budget tracks the swap without waiting for the next model call.
	// No plan is awaited — this never touches a model call.
	pi.on("model_select", (event) => {
		applyModel(event?.model as { id?: string; contextWindow?: number } | undefined);
		const ws = client;
		if (ws && ws.readyState === 1) {
			send(ws, { type: "sync", reqId: ++reqSeq, full: false, blocks: [], contextWindow });
		}
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
		latestCtx = null;
	});

	// ── /accordion : focus the app on this session + show status ────────────────
	pi.registerCommand("accordion", {
		description: "Open/focus Accordion on this pi session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			writeFocusRequest();
			// If the app is already attached to THIS session, its discovery poll will consume
			// focus.json and foreground the window. If it is not attached, launching the desktop
			// app is the only cross-process nudge we have; the app's single-instance guard turns
			// that into "focus the existing window" when it is already running elsewhere.
			const wasAttached = attached();
			const launch = wasAttached ? null : await launchAccordionApp(pi);
			const action = launchResultLine(launch);
			const lines = [
				action.text,
				`Live link: ${wasAttached ? "attached" : "detached"} · port ${port || "starting"} · streamed ${sentCount} blocks`,
			];
			ctx.ui.notify(lines.join("\n"), action.type);
		},
	});

	// ── unfold tool: let the live agent restore its own folded context ─────────
	// "GUI drives, extension is thin": the extension makes no unfold decisions. It
	// relays the agent's request to the GUI and reports back what the GUI scheduled.
	// The actual content restoration happens at the NEXT `context` hook — the unfolded
	// block simply doesn't appear in the fold plan — so the agent's past context changes
	// on its next turn. We don't echo the full content back: the past-context change
	// is the primary mechanism; echoing is a documented fallback if needed.
	pi.registerTool({
		name: "unfold",
		label: "Unfold Context",
		description:
			"Restore folded context. Accordion (the live context manager attached to this session) may replace older parts of YOUR OWN context with a short summary tagged like `{#3f9a2c FOLDED}`. The original content is preserved, not lost. Call this tool with the short code(s) from those tags to restore the full content. The restored content reappears in your context on your NEXT turn (your past context changes); this call confirms what was scheduled. Only unfold what you actually need — it costs tokens.",
		promptSnippet: "unfold(codes) — restore context folded by Accordion (blocks tagged {#<code> FOLDED}).",
		promptGuidelines: [
			"When you see a `{#<code> FOLDED}` marker in your context (e.g. `{#3f9a2c FOLDED}`), that block was compacted by Accordion to save tokens — the full content is preserved, not lost. If the summary is not enough for your current task, call `unfold` with the code(s) from the marker(s) to restore them; the content returns on your next turn.",
		],
		parameters: Type.Object({
			codes: Type.Array(Type.String({ description: 'A fold code copied verbatim from a {#<code> FOLDED} tag, e.g. "3f9a2c". Always a string (codes may have leading zeros).' }), {
				description: "One or more fold codes to restore to full content.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const codes = Array.isArray(params.codes)
				? params.codes.map((s) => String(s).trim()).filter((s) => s.length > 0)
				: [];
			if (!codes.length) {
				return { content: [{ type: "text", text: 'No fold codes given. Pass the code(s) from a {#<code> FOLDED} tag, e.g. unfold({codes:["3f9a2c"]}).' }] };
			}
			if (!attached()) {
				return { content: [{ type: "text", text: "Accordion isn't attached, so nothing in your context is folded right now — it is already full." }] };
			}
			const res = await requestUnfold(codes);
			if (res === null) {
				return { content: [{ type: "text", text: "Accordion did not respond. Folded content restores automatically if it detaches; otherwise try again." }], isError: true };
			}
			const lines: string[] = [];
			if (res.restored.length) {
				lines.push(`Unfolded ${res.restored.length} block(s); full content returns on your next turn:`);
				for (const r of res.restored) lines.push(`  • ${r?.label ?? "block"} (#${r?.code ?? "?"})`);
			}
			if (res.missing.length) {
				lines.push(`No folded block for: ${res.missing.map((c) => "#" + c).join(", ")} (already full, or not in this session's context).`);
			}
			// Every input code resolves to restored or missing, so `lines` is always non-empty.
			return { content: [{ type: "text", text: lines.join("\n") }], details: res };
		},
	});

	// ── recall tool: an UNBLOCKABLE READ of folded content (ADR 0011) ───────────
	// recall is the agent's counterpart to the human's "peek": it returns a folded block's
	// ORIGINAL full content AS a tool result THIS turn (like read_file) and does NOT change
	// what is standing in the agent's context — no override is created, the block stays
	// folded. That makes it safe-by-construction and therefore never lockable: it is the net
	// that keeps a locked `unfold` from blinding the agent. "GUI drives, extension is thin":
	// the extension only relays the request and echoes back the content the GUI returns.
	pi.registerTool({
		name: "recall",
		label: "Recall Folded Content",
		description:
			"Read folded context WITHOUT changing what's standing in your context. Accordion (the live context manager attached to this session) may replace older parts of YOUR OWN context with a short summary tagged like `{#3f9a2c FOLDED}`. The original content is preserved, not lost. Call this tool with the short code(s) from those tags to get the FULL original content back AS THIS tool's result, immediately — like reading a file. Unlike `unfold`, recall does NOT force the block open: your standing context is unchanged (the block stays folded), so recall costs nothing beyond this one tool result. Use it when you need folded detail RIGHT NOW for the current step.",
		promptSnippet: "recall(codes) — read folded content right now (returned as the tool result; does not change your standing context).",
		promptGuidelines: [
			"When you see a `{#<code> FOLDED}` marker and need the full content for the current step, call `recall` with the code(s) — the full original content comes back as this tool's result immediately, and your standing context is left unchanged (the block stays folded). Prefer `recall` over `unfold` when you only need the detail once; use `unfold` when you want the block to stay open across future turns.",
		],
		parameters: Type.Object({
			codes: Type.Array(Type.String({ description: 'A fold code copied verbatim from a {#<code> FOLDED} tag, e.g. "3f9a2c". Always a string (codes may have leading zeros).' }), {
				description: "One or more fold codes whose full original content to read.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const codes = Array.isArray(params.codes)
				? params.codes.map((s) => String(s).trim()).filter((s) => s.length > 0)
				: [];
			if (!codes.length) {
				return { content: [{ type: "text", text: 'No fold codes given. Pass the code(s) from a {#<code> FOLDED} tag, e.g. recall({codes:["3f9a2c"]}).' }] };
			}
			if (!attached()) {
				return { content: [{ type: "text", text: "Accordion isn't attached, so nothing in your context is folded right now — it is already full." }] };
			}
			const res = await requestRecall(codes);
			if (res === null) {
				return { content: [{ type: "text", text: "Accordion did not respond. If it has detached, your context is already full; otherwise try again." }], isError: true };
			}
			// The defining difference from `unfold`: echo the FULL original content back THIS turn,
			// one text block per recalled item, each prefixed with its label + code so the agent
			// knows what it is reading. A short note lists any codes that resolved to nothing.
			const content: Array<{ type: "text"; text: string }> = [];
			for (const r of res.restored) {
				content.push({ type: "text", text: `[recalled ${r?.label ?? "block"} (#${r?.code ?? "?"})]\n${r?.text ?? ""}` });
			}
			if (res.missing.length) {
				content.push({ type: "text", text: `No folded block for: ${res.missing.map((c) => "#" + c).join(", ")} (already full, or not in this session's context).` });
			}
			if (!content.length) {
				// Defensive: every input code resolves to restored or missing, so this is unreachable.
				content.push({ type: "text", text: "Nothing to recall." });
			}
			return { content, details: res };
		},
	});

	// ── skill discovery: expose the unfold skill to pi's skill loader ──────────
	// The skill directory is written by a separate agent; we just point pi at it.
	// Best-effort: a missing directory or any unexpected error must NEVER crash a session.
	pi.on("resources_discover", () => {
		try {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const skillDir = path.join(here, "skills", "accordion-context-folding");
			if (fs.existsSync(skillDir)) return { skillPaths: [skillDir] };
		} catch {
			/* best-effort — never break a session over skill discovery */
		}
		return {};
	});
}

// DEFAULT_PORT is retained in protocol.ts only as the browser dev-loop fallback
// (the desktop app discovers ephemeral ports via the registry); reference it so
// the import graph and the constant's purpose stay explicit.
export const BROWSER_FALLBACK_PORT = DEFAULT_PORT;

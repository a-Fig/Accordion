/*
 * accordion.ts — the pi extension, now the AUTHORITY for a live session's context (Phase B).
 *
 * The truth moved into the extension: it hosts an in-process `Truth` per session (core/truth.ts —
 * the same class the app once ran). pi's `context` hook is a LOCAL operation against that Truth —
 * NO 250ms GUI plan round trip. A client (the GUI) is a REPLICA + remote control over protocol v11.
 *
 * Per-hook loop (all local, no disk I/O, no await on any client):
 *   1. reconcile pi's `event.messages` against the Truth by a cheap durable-id walk. If it is our
 *      last-processed array plus a new suffix, linearize ONLY the suffix and append (O(Δ) text
 *      work). If it diverges structurally (compaction / fork / tree-nav / another extension rewrote
 *      it), REBUILD the Truth from scratch, re-mark all sent, and force clients to resnapshot —
 *      counted in telemetry.
 *   2. // PHASE C: wire-departing hold — a no-op seam where the conductor's last-moment fold plugs in.
 *   3. if folding is enabled (default OFF; a GUI command toggles it) → `truth.serializeWire` and
 *      return the replacement; else return undefined (passthrough). Either way the view stays live.
 *   4. markSent through the last serialized block.
 *   5. measure the whole hook duration and stream it as `telemetry`.
 *
 * `message_end` / `agent_end` append the finished message(s) to the Truth immediately — this kills
 * the one-turn lag. `model_select` → truth.setContextWindow. The agent's `unfold`/`recall` tools
 * resolve LOCALLY against the Truth (no client needed).
 *
 * Every Truth mutation emits a TruthEvent; a single subscription forwards each as a REPLAYABLE
 * `event` to all connected clients (append / ops / config / locks / sent / reset), rev-stamped.
 * A client replays inputs through its own replica Truth and resnapshots on a rev mismatch. Human
 * actions arrive as `command` messages; the host applies them and the resulting events echo back
 * (no optimistic apply on the client — loopback echo is sub-ms).
 *
 * Connection model: "pull" (docs/adr/0001-pi-live-integration.md). Each pi session binds an
 * ephemeral loopback port and advertises ~/.accordion/sessions/<id>.json for discovery; the
 * browser-served static UI + `/__accordion/sessions` + all WS auth (origin/token/loopback) are
 * UNCHANGED from before. `/__accordion/meta` now reports hook telemetry instead of plan outcomes.
 *
 * Safety:
 *   • No disk I/O on the `context` hook path.
 *   • Folding the live agent is OPT-IN and OFF by default; disabled ⇒ the model call is untouched.
 *   • pi's native /compact is suppressed ONLY while a client is attached.
 *   • The shared serialization (Truth.serializeWire → applyPlan) carries the provider-safety rules
 *     (durable-id + kind checks); the engine never folds a protected block.
 *
 * Register it in ~/.pi/agent/settings.json:
 *   { "extensions": ["<repo>/extension/accordion.ts"] }
 */
import { WebSocketServer, type WebSocket } from "ws";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { Truth } from "../core/truth";
import { linearize, type PiMessage } from "../core/wire";
import { serializeSnapshot, wireEventFromTruthEvent } from "../core/replica";
import { resolveUnfold, resolveRecall } from "../core/agentView";
import { messageInfo } from "../core/wire";
import type { TruthEvent } from "../core/events";
import {
	DEFAULT_PORT,
	PROTOCOL_VERSION,
	type Role,
	type ServerMessage,
	type StreamMessage,
	type WireCommand,
	type SnapshotState,
} from "../core/protocol";
import {
	REGISTRY_PROTOCOL,
	REGISTRY_DIR,
	SESSIONS_SUBDIR,
	FOCUS_FILE,
	HEARTBEAT_INTERVAL_MS,
	isLiveEntry,
	type SessionEntry,
	type FocusRequest,
} from "../app/src/lib/live/registry";

// Phase B: pi's `context` hook is a LOCAL operation against the in-process Truth — there is no
// GUI plan round trip, so the old ACCORDION_PLAN_TIMEOUT_MS / ACCORDION_PLAN_DEADLINE_MS knobs and
// the unfold/recall reply timeouts are gone. unfold/recall resolve synchronously against Truth.

// WebSocket frames otherwise inherit ws's 100 MiB default. Plans and control messages are
// normally kilobytes; 8 MiB leaves ample headroom while bounding allocation + JSON.parse work.
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
// Browser-served session A may switch to session B without possessing B's token. B verifies A
// through A's loopback-only /__accordion/meta endpoint plus the live registry. Bound that
// upgrade-time probe so an unrelated local port cannot tie up verifier work indefinitely.
const SIBLING_ORIGIN_PROBE_MS = 750;
const SIBLING_ORIGIN_META_MAX_BYTES = 16 * 1024;
const MAX_PENDING_SIBLING_ORIGIN_PROBES = 8;
// Vite's fixed localhost:1420 Origin is browser-obtainable, unlike Tauri's production custom
// origins. Trust it only for an explicit local development session; shipped installs stay closed.
const ALLOW_TAURI_DEV_ORIGIN = process.env.ACCORDION_ALLOW_TAURI_DEV_ORIGIN === "1";

/** Origins used by Accordion's Tauri webview. Normal web pages cannot mint these origins. */
function isTrustedTauriOrigin(origin: string): boolean {
	let u: URL;
	try { u = new URL(origin); } catch { return false; }
	if (u.username || u.password) return false;
	// Tauri v2 production origins: tauri://localhost on macOS/Linux and
	// https://tauri.localhost on Windows (the latter may also be http in older WebView2 builds).
	if (u.protocol === "tauri:" && u.hostname === "localhost" && !u.port) return true;
	if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname === "tauri.localhost" && !u.port) return true;
	// tauri.conf.json's Vite development URL — opt-in only because port 1420 is not a
	// cryptographically distinguished origin and may be occupied by unrelated local content.
	return ALLOW_TAURI_DEV_ORIGIN
		&& u.protocol === "http:"
		&& (u.hostname === "localhost" || u.hostname === "127.0.0.1")
		&& u.port === "1420";
}

// Base dir is overridable for tests (smoke.mjs) so they don't touch the real home.
const HOME = process.env.ACCORDION_HOME || os.homedir();
const REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
const SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
const FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);

const ACCORDION_APP_FLAG = "accordion-app";
const ACCORDION_APP_ENV = "ACCORDION_APP_PATH";

// The live link binds an OS-assigned ephemeral port on loopback (127.0.0.1) only — a
// same-machine surface. The desktop app's discovery dials 127.0.0.1; the browser-served
// page auto-connects to the same origin. There is no remote/off-loopback bind mode.

/** True if a socket peer address is loopback (127.0.0.1 / ::1, incl. IPv4-mapped IPv6). */
function isLoopbackPeer(addr: string | undefined | null): boolean {
	if (!addr) return false;
	const a = addr.toLowerCase();
	// Strip the IPv4-mapped IPv6 prefix so 127.0.0.1 is recognized under dual-stack.
	const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	return v4 === "127.0.0.1" || v4 === "::1" || v4 === "localhost";
}

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
	// The HTTP server that BOTH hosts the WebSocket upgrade AND serves the browser
	// build of the Accordion app on the same ephemeral port (feat/browser-served-extension).
	// One server per pi session; closed alongside `wss` at shutdown.
	let httpServer: http.Server | null = null;
	// Per-session token gating the HTTP surface and browser WebSocket upgrades. Native clients
	// without an Origin and the Tauri webview remain tokenless. Browser clients authenticate
	// explicitly, by an exact-origin cookie, or as a verified live sibling Accordion origin.
	let webToken = "";
	// Connected clients (Phase B: broadcast Truth events to ALL). Each carries its declared role;
	// `conductor` is carried through auth + tagged for Phase C. A client is a REPLICA + remote
	// control — it never mutates optimistically, only via the echoed event stream.
	const clients = new Map<WebSocket, { role: Role }>();
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", contextWindow: null as number | null, format: "pi" as const };
	let pendingSiblingOriginProbes = 0;

	// ── the authoritative Truth (Phase B) ──────────────────────────────────────
	// The single source of context state for this live session. Built at session_start, rebuilt on
	// structural divergence (compaction / fork / tree-nav / another extension rewriting messages).
	// pi's `context` hook operates against it LOCALLY. `unsubTruth` detaches the event forwarder.
	let truth: Truth | null = null;
	let unsubTruth: (() => void) | null = null;
	// Folding the live agent is OPT-IN and OFF by default (today's armed semantics). Toggled by a
	// GUI `setFolding` command; disabled ⇒ the model call is untouched. Broadcast on change and
	// carried in every snapshot so a reconnecting client sees the current arm.
	let foldingEnabled = false;

	// The last full messages array the Truth was reconciled against (an authoritative
	// context/agent_end snapshot, extended by message_end). pi's next `event.messages` is compared
	// against it by a cheap durable-id walk to decide append-a-suffix vs. rebuild.
	let lastMessages: PiMessage[] = [];

	// ── hook telemetry (replaces the plan-outcome ack) ──────────────────────────
	let hookCount = 0; // total `context` hook invocations this extension lifetime
	let lastHookMs = 0; // most recent hook duration (ms)
	let maxHookMs = 0; // worst hook duration
	let rebuilds = 0; // structural-divergence Truth rebuilds
	const hookDurations: number[] = []; // bounded ring for the p95 readout
	const HOOK_RING = 256;

	// Most recent ExtensionContext seen on any hook. Captured so the WS connection handler
	// (which gets no ctx of its own) can read pi's CURRENT session history at attach time — the
	// authoritative way to populate a session that already has turns (especially a RESUMED one).
	let latestCtx: ExtensionContext | null = null;

	// ── discovery (registry) state ──────────────────────────────────────────────
	let port = 0; // actual ephemeral port, filled once the server is listening
	let startedAt = 0;
	let model = "";
	let tokens: number | null = null;
	let contextWindow: number | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	// Set iff the HTTP server's bind failed (e.g. an unexpected EADDRINUSE on the ephemeral port).
	// Previously the "error" listener discarded the error entirely, so `port` stayed 0
	// forever and `/accordion` printed "port starting…" — indistinguishable from a slow,
	// still-booting server. Surfaced verbatim in the /accordion status line instead.
	let bindError: string | null = null;

	const attached = (): boolean => clients.size > 0;

	function send(ws: WebSocket, m: ServerMessage): void {
		try {
			ws.send(JSON.stringify(m));
		} catch {
			/* socket gone */
		}
	}

	/** Send a message to every connected client (Phase B fan-out). */
	function broadcast(m: ServerMessage): void {
		for (const ws of clients.keys()) if (ws.readyState === 1 /* OPEN */) send(ws, m);
	}

	/** Forward a host Truth event to every replica as a replayable `event` (null ⇒ nothing to replay). */
	function forwardTruthEvent(e: TruthEvent): void {
		const ev = wireEventFromTruthEvent(e);
		if (ev) broadcast({ type: "event", event: ev });
	}

	/** Broadcast a stream lifecycle frame to every attached client (presentation-only ghosts). */
	function sendStream(frame: StreamMessage): void {
		broadcast(frame);
	}

	// ── hook telemetry ──────────────────────────────────────────────────────────
	function recordHook(ms: number): void {
		hookCount++;
		lastHookMs = ms;
		if (ms > maxHookMs) maxHookMs = ms;
		hookDurations.push(ms);
		if (hookDurations.length > HOOK_RING) hookDurations.shift();
	}
	function p95HookMs(): number {
		if (!hookDurations.length) return 0;
		const sorted = [...hookDurations].sort((a, b) => a - b);
		return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
	}
	function broadcastTelemetry(): void {
		broadcast({ type: "telemetry", lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, hookCount });
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

	/**
	 * Read every OTHER live session's advertised entry alongside our own. This is plain
	 * Node `fs` access (unlike a browser tab, this extension process is never filesystem-
	 * sandboxed) — the same directory the desktop app's Tauri layer reads, just read from
	 * the other side. Powers the browser-served multi-session sidebar (no Tauri required):
	 * any one session's HTTP server can list every session on the machine. Best-effort:
	 * an unreadable directory or a partially-written/corrupt file is skipped, never thrown.
	 *
	 * ASYNC (fs.promises), not fs.*Sync: this runs on the same event loop as the `context`
	 * hook's `requestPlan`, which only allows REQUEST_TIMEOUT_MS (250ms) before falling back
	 * to passthrough. A browser tab polls this every second — synchronous directory/file I/O
	 * here would add avoidable jitter to that budget; the async form yields between files.
	 *
	 * Opportunistically REAPS dead entries it encounters (unlike a bare read): a browser-only
	 * user has no desktop app ever running to clean up `~/.accordion/sessions/` after a
	 * SIGKILLed pi (skips session_shutdown's own deleteEntry), so if nothing reaps here, stale
	 * files accumulate forever for exactly this feature's target user. Mirrors the desktop
	 * app's own reap-on-poll behavior (discovery.svelte.ts). Deleting a stale file is itself
	 * best-effort and never blocks the response.
	 */
	async function listLiveSessions(): Promise<SessionEntry[]> {
		const now = Date.now();
		const out: SessionEntry[] = [];
		let names: string[] = [];
		try {
			names = await fs.promises.readdir(SESSIONS_DIR);
		} catch {
			return out;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const filePath = path.join(SESSIONS_DIR, name);
			let raw: unknown;
			try {
				raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
			} catch {
				continue; // partial write / corrupt file / deleted mid-scan — skip, never crash
			}
			if (isLiveEntry(raw, now)) {
				out.push(raw);
			} else if (raw && typeof raw === "object" && typeof (raw as { sessionId?: unknown }).sessionId === "string") {
				// Recognizably a registry entry, just stale or an old protocol version — reap it.
				// A merely-paused (not dead) session self-heals: its next heartbeat rewrites the
				// file, so reaping a transient staleness read is harmless — UNLESS that heartbeat
				// lands in the gap between our read above and the unlink below, in which case we'd
				// delete a file a concurrent writeEntry() just atomically renamed into place (a live
				// session's live advertisement). Narrow that window: re-read + re-check staleness
				// immediately before unlinking. This does not ELIMINATE the race (a heartbeat could
				// still land between this re-check and the unlink itself), only narrows it from "one
				// readdir pass" to "one extra read" — accepted, since closing it fully would need a
				// file lock this best-effort registry deliberately doesn't have. Any read/parse
				// failure here (file renamed/deleted mid-recheck) is swallowed: nothing to reap.
				fs.promises
					.readFile(filePath, "utf8")
					.then((freshRaw) => {
						let fresh: unknown;
						try {
							fresh = JSON.parse(freshRaw);
						} catch {
							return; // corrupt/partial re-read — leave it for the next pass
						}
						if (isLiveEntry(fresh, Date.now())) return; // a heartbeat healed it — don't reap
						return fs.promises.unlink(filePath);
					})
					.catch(() => {});
			}
		}
		out.sort((a, b) => a.startedAt - b.startedAt);
		return out;
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

	// ── static file serving for the browser build ──────────────────────────────
	// extension→MIME map. Unknown extensions fall back to application/octet-stream.
	const MIME: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript",
		".mjs": "text/javascript",
		".css": "text/css",
		".json": "application/json",
		".png": "image/png",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".woff2": "font/woff2",
		".woff": "font/woff",
		".txt": "text/plain",
		".map": "application/json",
	};

	/**
	 * Resolve the directory holding the browser build, or null if none exists.
	 * Two layouts:
	 *   • dist/client          — the PUBLISHED layout (build-client.mjs copies app/build here)
	 *   • ../app/build         — the repo DEV layout (SvelteKit's adapter-static output)
	 * First existing wins; checked on every request (cheap) so a build appearing later works.
	 */
	function resolveClientRoot(): string | null {
		try {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const candidates = [path.join(here, "dist", "client"), path.resolve(here, "..", "app", "build")];
			for (const dir of candidates) {
				try {
					if (fs.statSync(dir).isDirectory()) return dir;
				} catch {
					/* try next */
				}
			}
		} catch {
			/* fall through to null */
		}
		return null;
	}

	// Cookie name is PORT-QUALIFIED (not just "accordion_token"): cookies are host-scoped, not
	// port-scoped, so two sessions on the same host (e.g. two pi sessions both browser-served on
	// 127.0.0.1, different ports) would otherwise clobber each other's cookie — opening session B
	// overwrites A's `accordion_token` cookie, and A's next cookie-authed request 403s. Qualifying
	// by port keeps each session's cookie distinct. `port` is closed over and only read from
	// request handlers, which never run before `startServer`'s `listen` callback sets it.
	function accordionCookieName(): string {
		return `accordion_token_p${port}`;
	}

	/** Is this request authenticated for static-file serving? (token query OR cookie.) */
	function isWebAuthed(req: http.IncomingMessage, u: URL): boolean {
		if (!webToken) return false;
		if (u.searchParams.get("token") === webToken) return true;
		const cookie = req.headers["cookie"];
		if (typeof cookie === "string" && cookie.split(";").some((c) => c.trim() === `${accordionCookieName()}=${webToken}`)) return true;
		return false;
	}

	/**
	 * HTTP request handler — serves the browser build of the Accordion app, gated by a
	 * per-session token. Runs ENTIRELY off the pi `context`/model-call hook path: it does
	 * no folding, touches no plan, and a failure to serve a file never crashes a session
	 * (every path is wrapped). The token gates file serving; `/meta` is ungated (loopback-only).
	 */
	function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
		try {
			const u = new URL(req.url || "/", "http://127.0.0.1");

			// Meta endpoint. UNGATED — the whole surface is loopback-only, and local tooling (the
			// smoke test, bellows polling from the same machine) and the browser's own same-origin
			// fetch all depend on reading it without a token.
			if (u.pathname === "/__accordion/meta") {
				res.writeHead(200, { "Content-Type": "application/json" });
				// Phase B telemetry: the `context` hook is a local operation, so instead of plan
				// outcomes we report the hook-duration stream (proving the local path is fast) plus
				// the structural-rebuild count and the current folding-enabled arm. `served`/
				// `sessionId`/`protocolVersion` are unchanged (the sibling-origin probe depends on them).
				res.end(
					JSON.stringify({
						served: true,
						sessionId,
						protocolVersion: PROTOCOL_VERSION,
						telemetry: { hookCount, lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, foldingEnabled },
					}),
				);
				return;
			}

			// Session list — powers the browser-served multi-session sidebar. TOKEN-GATED
			// (unlike /meta): it reveals cwd/title/model across every live session on the
			// machine, not just this one, so it must not be reachable without the token — a
			// leaked token for THIS session otherwise exposes every other live session's
			// port/cwd/title/model too. An accepted tradeoff for the multi-session sidebar.
			if (u.pathname === "/__accordion/sessions") {
				if (!isWebAuthed(req, u)) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "forbidden" }));
					return;
				}
				void listLiveSessions().then(
					(sessions) => {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ sessions }));
					},
					() => {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "internal error" }));
					},
				);
				return;
			}

			// Everything below is the static file surface — token-gated.
			if (!isWebAuthed(req, u)) {
				res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Forbidden — open Accordion via the /accordion command's Browser link (it carries the session token).");
				return;
			}
			// A valid ?token mints a cookie so subsequent same-origin requests (the SvelteKit
			// asset fetches, which don't carry the query string) stay authenticated.
			const headers: Record<string, string> = {};
			if (u.searchParams.get("token") === webToken) {
				headers["Set-Cookie"] = `${accordionCookieName()}=${webToken}; HttpOnly; SameSite=Strict; Path=/`;
			}

			const root = resolveClientRoot();
			if (!root) {
				res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
				res.end("No browser build found. Run `npm run build` in app/, or `npm run build:client` in extension/.");
				return;
			}

			// Map the URL path to a file under root. "/" → index.html.
			let rel = decodeURIComponent(u.pathname);
			if (rel === "/") rel = "/index.html";
			let filePath = path.join(root, rel);

			// Path-traversal guard: the resolved absolute path MUST stay under root.
			const rootResolved = path.resolve(root);
			if (path.resolve(filePath) !== rootResolved && !path.resolve(filePath).startsWith(rootResolved + path.sep)) {
				res.writeHead(403, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
				res.end("Forbidden");
				return;
			}

			// SPA fallback: adapter-static emits `fallback: index.html`. If the requested
			// path doesn't exist AND has no file extension (i.e. it's a client route, not a
			// missing asset), serve index.html so deep links / refreshes work. A missing
			// path WITH an extension is a genuine 404.
			let exists = false;
			try {
				exists = fs.statSync(filePath).isFile();
			} catch {
				exists = false;
			}
			if (!exists) {
				if (path.extname(rel) === "") {
					filePath = path.join(root, "index.html");
				} else {
					res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
					res.end("Not found");
					return;
				}
			}

			let body: Buffer;
			try {
				body = fs.readFileSync(filePath);
			} catch {
				res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not found");
				return;
			}
			const mime = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
			res.writeHead(200, { ...headers, "Content-Type": mime });
			res.end(body);
		} catch {
			// Best-effort: never let a serving error escape and crash the session.
			try {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			} catch {
				/* response already gone */
			}
		}
	}

	function hasAccordionCookie(req: http.IncomingMessage): boolean {
		const cookie = req.headers.cookie;
		return !!webToken && typeof cookie === "string"
			&& cookie.split(";").some((part) => part.trim() === `${accordionCookieName()}=${webToken}`);
	}

	/**
	 * Cookies are ambient and host-scoped, not port-scoped. Only accept Accordion's cookie when
	 * the browser Origin exactly names this upgrade Host on a literal loopback hostname. The
	 * literal-host requirement prevents DNS rebinding from turning matching attacker-controlled
	 * Origin/Host strings into authority over a loopback connection.
	 */
	function isExactServedOrigin(req: http.IncomingMessage, origin: string): boolean {
		const host = req.headers.host;
		if (typeof host !== "string" || !host) return false;
		try {
			const u = new URL(origin);
			if (u.protocol !== "http:" || u.username || u.password) return false;
			if (u.host.toLowerCase() !== host.trim().toLowerCase()) return false;
			const hostname = u.hostname.toLowerCase();
			return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
		} catch {
			return false;
		}
	}

	/**
	 * Browser-served mode intentionally supports switching from session A's page to sibling B.
	 * A does not know B's token, so B verifies that A is a currently live Accordion loopback
	 * origin. A literal host check defeats DNS rebinding; a bounded live /meta probe proves
	 * current port ownership; the matching registry identity prevents an unrelated local HTTP
	 * service from authorizing itself by copying the public JSON shape.
	 */
	function isKnownAccordionLoopbackOrigin(origin: string): Promise<boolean> {
		let u: URL;
		try { u = new URL(origin); } catch { return Promise.resolve(false); }
		if (u.protocol !== "http:" || u.username || u.password) return Promise.resolve(false);
		const hostname = u.hostname.toLowerCase();
		if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return Promise.resolve(false);
		const originPort = Number(u.port || 80);
		if (!Number.isSafeInteger(originPort) || originPort <= 0 || originPort > 65535) return Promise.resolve(false);
		if (pendingSiblingOriginProbes >= MAX_PENDING_SIBLING_ORIGIN_PROBES) return Promise.resolve(false);
		const requestHost = hostname === "[::1]" ? "::1" : hostname;
		pendingSiblingOriginProbes++;

		return new Promise((resolve) => {
			let settled = false;
			let request: http.ClientRequest | null = null;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				pendingSiblingOriginProbes--;
				clearTimeout(deadline);
				resolve(ok);
			};
			const deadline = setTimeout(() => {
				request?.destroy();
				finish(false);
			}, SIBLING_ORIGIN_PROBE_MS);
			request = http.get({ hostname: requestHost, port: originPort, path: "/__accordion/meta" }, (response) => {
				if (response.statusCode !== 200 || !isLoopbackPeer(response.socket.remoteAddress)) {
					response.destroy();
					finish(false);
					return;
				}
				const contentType = response.headers["content-type"];
				if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
					response.destroy();
					finish(false);
					return;
				}
				const chunks: Buffer[] = [];
				let bodyBytes = 0;
				response.on("data", (chunk: Buffer) => {
					bodyBytes += chunk.length;
					if (bodyBytes > SIBLING_ORIGIN_META_MAX_BYTES) {
						response.destroy();
						finish(false);
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (settled) return;
					try {
						const sibling = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
							served?: unknown; sessionId?: unknown; protocolVersion?: unknown;
						};
						if (sibling.served !== true || typeof sibling.sessionId !== "string" || sibling.protocolVersion !== PROTOCOL_VERSION) {
							finish(false);
							return;
						}
						void listLiveSessions().then(
							(sessions) => finish(sessions.some((s) => s.sessionId === sibling.sessionId && s.port === originPort)),
							() => finish(false),
						);
					} catch {
						finish(false);
					}
				});
				response.on("aborted", () => finish(false));
				response.on("error", () => finish(false));
			});
			request.on("error", () => finish(false));
		});
	}

	/**
	 * Loopback binding blocks network peers, but not cross-site WebSocket hijacking: browsers do
	 * not apply CORS to WebSocket handshakes. A hostile page that finds the ephemeral port could
	 * otherwise replace the GUI, read the backlog, and steer plans.
	 */
	function verifyWsUpgrade(info: { req: http.IncomingMessage }, cb: (res: boolean, code?: number, message?: string) => void): void {
		const req = info.req;
		if (!isLoopbackPeer(req.socket.remoteAddress)) {
			cb(false, 403, "loopback connection required");
			return;
		}

		let token: string | null;
		try {
			token = new URL(req.url || "/", "http://accordion.local").searchParams.get("token");
		} catch {
			// ws does not protect callback-style verifyClient from a synchronous throw.
			cb(false, 400, "bad request target");
			return;
		}

		const origin = req.headers.origin;
		if (typeof origin !== "string" || origin === "") { cb(true); return; } // native client
		if (isTrustedTauriOrigin(origin)) { cb(true); return; }
		if (!!webToken && token === webToken) { cb(true); return; } // explicit bearer
		if (hasAccordionCookie(req) && isExactServedOrigin(req, origin)) { cb(true); return; }

		// A browser page served by another live Accordion session is the one intentional
		// cross-origin path. verifyClient supports an asynchronous callback.
		void isKnownAccordionLoopbackOrigin(origin).then(
			(ok) => cb(ok, ok ? undefined : 403, ok ? undefined : "cross-origin WebSocket blocked"),
			() => cb(false, 403, "cross-origin WebSocket blocked"),
		);
	}

	function startServer(): void {
		if (wss || httpServer) return;
		bindError = null; // fresh attempt — clear any failure a prior call recorded
		// Per-session token for the HTTP surface and browser WebSocket upgrades. Native/Tauri
		// clients and verified sibling Accordion origins are the only tokenless paths.
		webToken = crypto.randomBytes(16).toString("hex");
		try {
			// One HTTP server hosts BOTH halves on the SAME ephemeral loopback port:
			//   • HTTP GETs → handleHttp (the browser build, token-gated)
			//   • WS upgrades → the WebSocketServer below (loopback-only, Origin/token-gated)
			// port 0 ⇒ OS assigns a free ephemeral port (one server per pi session).
			httpServer = http.createServer(handleHttp);
			// Attach the WS server to the HTTP server (NOT { port: 0 }) so the upgrade
			// shares the port. maxPayload bounds memory/parse work before protocol validation.
			wss = new WebSocketServer({ server: httpServer, verifyClient: verifyWsUpgrade, maxPayload: MAX_WS_PAYLOAD_BYTES });
			httpServer.on("error", (err: NodeJS.ErrnoException) => {
				// Unexpected listen failure (e.g. EADDRINUSE): run headless (passthrough), but
				// record and log WHY, so `/accordion` can show a real failure instead of an
				// eternal "port starting…". No retry: a visible failure is the fix.
				const code = err?.code ?? "unknown";
				bindError = `bind failed: ${code}`;
				console.warn(`[accordion] ${bindError}`);
				try { httpServer?.close(); } catch { /* ignore */ }
				httpServer = null;
				wss = null;
			});
			httpServer.listen(0, "127.0.0.1", () => {
				const addr = httpServer?.address();
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
			try { httpServer?.close(); } catch { /* ignore */ }
			httpServer = null;
			wss = null;
			return;
		}
		wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
			const role = roleFromUrl(req?.url);
			// Bring the Truth up to date with the session's current history BEFORE snapshotting.
			// On a resumed/loaded session no hook has fired yet, so read straight from the session
			// manager. This runs before `ws` joins `clients`, so any resulting append events reach
			// only the ALREADY-connected clients — the new client gets the up-to-date snapshot next.
			const history = readSessionMessages(latestCtx);
			if (history.length) ingestMessages(history);

			send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, role, meta });
			if (truth) send(ws, { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
			// Seed the client's latency badge with current telemetry (blank until the first hook otherwise).
			send(ws, { type: "telemetry", lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, hookCount });
			// Register only AFTER the snapshot so no event can precede the replica it must replay onto.
			clients.set(ws, { role });

			ws.on("message", (data: Buffer) => {
				if (!clients.has(ws)) return; // ignore stray messages from a dropped socket
				let msg: any;
				try {
					msg = JSON.parse(data.toString());
				} catch {
					return;
				}
				// The one client→server message: a remote-control command. The host applies it to the
				// authoritative Truth (emitting events to ALL clients) and replies with the per-op
				// results + resulting rev. There is NO optimistic apply on the client — the replica
				// mutates only via the echoed event stream, so a command and its events can't race.
				if (msg?.type === "command" && typeof msg.seq === "number" && msg.cmd && typeof msg.cmd === "object") {
					const { results, rev } = applyCommand(msg.cmd as WireCommand);
					send(ws, { type: "commandResult", seq: msg.seq, results, rev });
				}
			});
			const drop = () => {
				clients.delete(ws);
			};
			ws.on("close", drop);
			ws.on("error", drop);
		});
		wss.on("error", () => {
			/* e.g. unexpected WS error — run headless (passthrough). Tear down the shared
			   HTTP server too so we don't leave an orphaned listener serving files. */
			try { httpServer?.close(); } catch { /* ignore */ }
			httpServer = null;
			wss = null;
		});
	}

	/**
	 * Send a sync and await the GUI's plan. Resolves a discriminated PlanResult:
	 *   • "unsent"  — no GUI attached at call time (nothing sent).
	 *   • "timeout" — sent, but no reply within the governing wait (the caller falls back to
	 *                 the last known plan). `waitedMs` is that wait: PLAN_DEADLINE_MS when the
	 *                 caller passes `armedNow`, PLAN_TIMEOUT_MS otherwise. Snapshotted by the
	 *                 caller (the `context` hook) so an in-flight wait keeps its value.
	 *   • "plan"    — the GUI replied (delivered via the pending resolver / flushPending).
	 * The pending resolver is also driven by flushPending() (→ "unsent") on a superseded /
	 * dropped / shutting-down GUI, so a mid-wait disconnect never runs out the full timer.
	 *
	 * This is the ONE sync site whose reply is actually APPLIED to a model call (the `context`
	 * hook below). Every other sync site in this file is VIEW-ONLY.
	 */
	function requestPlan(reqId: number, full: boolean, blocks: ReturnType<typeof linearize>, armedNow: boolean): Promise<PlanResult> {
		const waitMs = armedNow ? PLAN_DEADLINE_MS : PLAN_TIMEOUT_MS;
		return new Promise((resolve) => {
			const ws = client;
			if (!ws || ws.readyState !== 1) return resolve({ kind: "unsent" });
			const timer = setTimeout(() => {
				if (pending.has(reqId)) {
					pending.delete(reqId);
					resolve({ kind: "timeout", waitedMs: waitMs }); // delivered but no reply in time → caller applies last known plan
				}
			}, waitMs);
			pending.set(reqId, (r) => {
				clearTimeout(timer);
				resolve(r);
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
		// Invalidate any `context` await still in flight from the OLD session BEFORE resetting
		// the cursor below — mirrors the GUI-reconnect path (flushPending() then epoch++).
		// Without this, a plan for the old session that lands after this switch still passes
		// the epoch guard (`epoch !== myEpoch`) and applies against the NEW session: it
		// re-inflates `sentCount` with the old session's block count (delta-cursor corruption)
		// and overwrites `lastPlan` with the old session's plan.
		flushPending();
		epoch++;
		latestCtx = ctx;
		sessionId = `s-${process.pid}-${Date.now()}`;
		sentCount = 0;
		lastPlan = null; // fresh session → no known plan yet (cursor also resets here)
		armed = false; // fresh session → disarmed until the (re)attached client declares otherwise
		lastPlanRttMs = null;
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
		// Clear any stash from a previous request FIRST, before the no-GUI early return below.
		// Otherwise an aborted turn (no assistant message_end to consume it) followed by a GUI
		// detach leaves the old RTT sitting in the stash, and the next message_end — for an
		// unrelated message — stamps it on the wrong reply.
		lastPlanRttMs = null;
		latestCtx = ctx;
		const myEpoch = epoch;
		// Snapshot the armed flag SYNCHRONOUSLY with myEpoch, BEFORE the await below. Mid-toggle
		// semantics: an in-flight `context` wait keeps the value it started with; the NEXT request
		// picks up a value the client changed meanwhile. This governs whether requestPlan waits the
		// hard deadline (armed) or the short timeout (disarmed), and which log fires on a miss.
		const myArmed = armed;
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
		if (!attached()) {
			recordPlanOutcome("no-gui", null, { ops: 0, groups: 0 }, null);
			return; // no GUI → pass through untouched
		}

		const fresh = all.slice(sentCount);
		const reqId = ++reqSeq;
		const full = sentCount === 0;
		// Measure the plan round-trip (Feature C). Stashed for `message_end` regardless of
		// outcome — the assistant message this request produces waited this long, whatever
		// the result (applied / stale-fallback / timeout).
		const t0 = Date.now();
		const result = await requestPlan(reqId, full, fresh, myArmed);
		lastPlanRttMs = Date.now() - t0;

		if (epoch !== myEpoch) {
			// A new client attached mid-wait, superseding the view this request was sent to.
			// Ack the CURRENT client anyway (it can still count the outcome) — its `reqId`
			// belongs to the superseded view, not to anything the current client itself sent.
			recordPlanOutcome("epoch-mismatch", reqId, { ops: 0, groups: 0 }, client);
			return; // GUI reconnected mid-flight → don't apply/advance
		}
		if (result.kind === "unsent") {
			recordPlanOutcome("unsent", reqId, { ops: 0, groups: 0 }, null);
			return; // couldn't deliver (no GUI / dropped) → pass through, don't advance
		}

		if (result.kind === "timeout") {
			// Issue #58: the plan missed the wait. Blocks WERE delivered, so advance the cursor
			// as before — but instead of shipping unfolded, re-apply the LAST KNOWN plan (a
			// one-turn-stale, id-addressed plan is strictly better than none; applyPlan passes
			// through ops for ids no longer present). Never silent: log cause + reqId + elapsed.
			sentCount = Math.max(sentCount, all.length);
			const elapsed = lastPlanRttMs;
			const hasStale = !!lastPlan && (lastPlan.ops.length > 0 || lastPlan.groups.length > 0);
			// Three distinct outcomes, not two: a cached EMPTY plan (lastPlan set, 0 ops/groups
			// — the conductor explicitly asked for no folds) still passes through unfolded,
			// same as genuinely having no cached plan at all — but the two causes are worth telling
			// apart in the log rather than both reading as "no cached plan".
			const detail = hasStale
				? `applying last known plan (${lastPlan!.ops.length} ops, ${lastPlan!.groups.length} groups)`
				: lastPlan
					? "cached plan is empty (no folds) — passing through unfolded"
					: "no cached plan — passing through unfolded";
			if (myArmed) {
				// Armed promised to hold the budget and didn't: shout, don't whisper. `result.waitedMs`
				// is the deadline this request was supposed to honor (carried out of requestPlan).
				console.error(`[accordion] armed deadline missed: plan reqId=${reqId} did not arrive within ${result.waitedMs}ms (waited ${elapsed}ms) — ${detail}`);
			} else {
				console.warn(`[accordion] plan timeout: reqId=${reqId} after ${elapsed}ms — ${detail}`);
			}
			// `recordPlanOutcome` below acks `timeout-stale`/`timeout-raw` to the GUI for its
			// wire-outcome tally (ADR 0020).
			if (hasStale) {
				// Apply FIRST, ack AFTER — with the counts applyPlan actually substituted, not the
				// stale plan's submitted lengths. A stale plan re-applied against messages that have
				// moved on can easily have ids that no longer match anything live; the old code acked
				// `lastPlan!.ops.length` etc. regardless, over-reporting what really rode the wire
				// (ADR 0020 promises counts ACTUALLY applied).
				const appliedCounts: AppliedCounts = { ops: 0, groups: 0 };
				const newMessages = applyPlan(
					event.messages as unknown as PiMessage[],
					lastPlan!.ops,
					lastPlan!.groups,
					appliedCounts,
				);
				recordPlanOutcome("timeout-stale", reqId, appliedCounts, client);
				return { messages: newMessages as unknown as AgentMessage[] };
			}
			recordPlanOutcome("timeout-raw", reqId, { ops: 0, groups: 0 }, client);
			return;
		}

		// result.kind === "plan": the GUI replied. Cache it (even when empty — that is the
		// conductor explicitly asking for NO folds, and caching it stops a later timeout from
		// wrongly resurrecting an older non-empty plan).
		const plan = result.plan;
		lastPlan = plan;
		sentCount = Math.max(sentCount, all.length); // advance cursor; never rewind (a message_end during the await may have advanced it further)
		if (plan.ops.length === 0 && plan.groups.length === 0) {
			recordPlanOutcome("empty-plan", reqId, { ops: 0, groups: 0 }, client);
			return; // empty plan → pass through
		}

		// Apply FIRST, ack AFTER (same reasoning as the timeout-stale branch above): a shape-valid
		// op/group whose id matches nothing live in `messages` is silently skipped by applyPlan, so
		// the SUBMITTED plan length (`plan.ops.length` etc.) can overstate what actually rode the
		// wire. `appliedCounts` reflects the real substitutions.
		const appliedCounts: AppliedCounts = { ops: 0, groups: 0 };
		const newMessages = applyPlan(event.messages as unknown as PiMessage[], plan.ops, plan.groups, appliedCounts);
		recordPlanOutcome("applied", reqId, appliedCounts, client);
		return { messages: newMessages as unknown as AgentMessage[] };
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
	//
	// This handler ALSO carries the Feature C RTT injection. That is deliberately merged
	// here rather than split into a second `pi.on("message_end", …)`:
	//   • The vendored pi SDK composes multiple handlers on one event reliably (loader.js
	//     pushes each into a per-event array; runner.js emitMessageEnd chains their returned
	//     messages, so a second handler WOULD work in production) — but smoke.mjs's mock
	//     `pi.on` overwrites per event (last-wins), so a second handler would silently drop
	//     one of the two in tests.
	//   • Injection must run even when no GUI is attached, otherwise a value stashed while a
	//     GUI was briefly attached could leak onto a later assistant message. Keeping it in
	//     ONE handler, above the no-GUI guard, guarantees the stash is always consumed+cleared.
	// So the RTT stamp is computed first (and returned at every exit), then the view-only
	// sync push runs only when a GUI is attached.
	pi.on("message_end", (event) => {
		// ── Feature C: stamp usage.rttMs onto the assistant message this request produced ──
		// Persisted verbatim: pi applies this replacement in place (agent-session._replace-
		// MessageInPlace) and SessionManager.appendMessage JSON-serializes the whole message,
		// so arbitrary `usage` keys survive to the session file. Consume+clear the stash so a
		// message with no preceding context RTT (null) gets no field.
		let replacement: AgentMessage | undefined;
		const finished = event.message as unknown as PiMessage & { role?: string; usage?: Record<string, unknown> };
		if (finished && finished.role === "assistant" && lastPlanRttMs !== null) {
			const rttMs = lastPlanRttMs;
			lastPlanRttMs = null;
			replacement = { ...(event.message as object), usage: { ...(finished.usage ?? {}), rttMs } } as unknown as AgentMessage;
		}

		// pi's MessageEndEventResult requires `{ message }` — emitMessageEnd does
		// `if (!handlerResult?.message) continue;`, so a bare message is silently
		// dropped and the RTT stamp never reaches the session file. Wrap every exit.
		const finish = () => (replacement ? { message: replacement } : undefined);

		const ws = client;
		if (!ws || ws.readyState !== 1) return finish(); // no GUI → nothing to push (still stamp RTT)

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
		if (all.length <= sentCount) return finish(); // nothing new to push (RTT stamp still returned)
		const reqId = ++reqSeq;
		const full = sentCount === 0;
		send(ws, { type: "sync", reqId, full, blocks: all.slice(sentCount) });
		sentCount = all.length; // advance cursor; agent_end and next context will dedup
		return finish(); // hand the RTT-stamped assistant message back to pi, wrapped per MessageEndEventResult (undefined = unchanged)
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
		// Close the shared HTTP server too — it owns the ephemeral port the WS rode on,
		// so leaving it open would keep serving files (and hold the port) after shutdown.
		try {
			httpServer?.close();
		} catch {
			/* ignore */
		}
		httpServer = null;
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
			// Port status: the real port once bound, a captured bind FAILURE (no more eternal
			// "starting…" on an EADDRINUSE-type error — see startServer's httpServer "error"
			// handler), or "starting" while the async listen() is still pending.
			const portStatus = port ? String(port) : bindError ? `failed (${bindError})` : "starting";
			const lines = [
				action.text,
				`Live link: ${wasAttached ? "attached" : "detached"} · port ${portStatus} · streamed ${sentCount} blocks`,
			];
			// Browser entry point: the extension also serves the web build of Accordion on
			// the same ephemeral loopback port, gated by a per-session token. Surface the
			// tokenized URL so the user can open the UI in a browser instead of the desktop app.
			if (port && webToken) {
				lines.push(`Browser: http://127.0.0.1:${port}/?token=${webToken}`);
			} else if (bindError) {
				lines.push(`Browser: unavailable — ${bindError}`);
			} else {
				lines.push("Browser: starting…");
			}
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
			const skillPaths: string[] = [];
			for (const name of ["accordion-context-folding", "accordion-context-recall"]) {
				const dir = path.join(here, "skills", name);
				if (fs.existsSync(dir)) skillPaths.push(dir);
			}
			if (skillPaths.length) return { skillPaths };
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

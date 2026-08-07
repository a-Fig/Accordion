/*
 * accordion.ts — the pi extension, now the AUTHORITY for a live session's context (Phase B).
 *
 * The truth moved into the extension: it hosts an in-process `Truth` per session (core/truth.ts —
 * the same class the app once ran). pi's `context` hook is a LOCAL operation against that Truth —
 * NO 250ms GUI plan round trip. A client (the GUI) is a REPLICA + remote control over protocol v12.
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
import { linearize, messageInfo, wireToBlock, type PiMessage } from "../core/wire";
import { serializeSnapshot, wireEventFromTruthEvent } from "../core/replica";
import { resolveUnfold, resolveRecall } from "../core/agentView";
import type { SessionMeta } from "../core/types";
import { applyGuardingHostOnly, type OpResult } from "../core/ops";
import type { TruthEvent } from "../core/events";
import {
	DEFAULT_PORT,
	PROTOCOL_VERSION,
	type Role,
	type ServerMessage,
	type StreamMessage,
	type WireCommand,
} from "../core/protocol";
import { LiveConductorHost, type SpawnedRunner } from "../core/conductor/liveHost";
import { catalogMeta } from "../core/conductor/registry";
import type { CompletionRequest, CompletionResult } from "../core/conductor/contract";
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
// Phase C: an attached conductor's out-of-band `complete()` launches real provider work. Keep the
// spend bound process-wide (across in-process + spawned conductors) and finish before the wire's own
// safety timeout. `envPositiveInt` keeps smoke/CI fast; invalid values retain the production default.
const MAX_CONCURRENT_COMPLETIONS = 4;
function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (typeof raw !== "string") return fallback;
	const n = Number(raw.trim());
	return Number.isInteger(n) && n > 0 ? n : fallback;
}
const COMPLETION_TIMEOUT_MS = envPositiveInt("ACCORDION_COMPLETION_TIMEOUT_MS", 110_000);

/** Test seam mirroring dc037bc: production resolves pi-ai lazily through pi's package alias. */
type CompletionFunction = (
	model: any,
	context: { systemPrompt?: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; maxTokens?: number },
) => Promise<any>;
interface RuntimeDependencies {
	complete?: CompletionFunction;
}
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

export default function accordionLive(pi: ExtensionAPI, dependencies: RuntimeDependencies = {}): void {
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
	// Phase C: the socket of the currently-attached spawn conductor (null for none / in-process).
	// `sendToConductor` routes to it; the connection handler sets it on accept, clears it on close.
	let conductorWs: WebSocket | null = null;
	// Most recent full model object (dc037bc's `latestModel`) — a completion needs the whole object
	// (apiKey resolution + maxTokens ceiling), not just the id string kept in `model`.
	let latestModelObj: any = null;
	// Process-wide in-flight completion count, bounded by MAX_CONCURRENT_COMPLETIONS.
	let activeCompletions = 0;

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
	let hookErrors = 0; // `context` hook throws caught by the passthrough guard (should stay 0)
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

	// ── Phase C: the live conductor host (registry, locks, wire-departing hold, completion relay) ─
	// Fully dependency-injected; every capability it needs — the live Truth, client fan-out, the
	// conductor socket, token minting, the spawn bridge, the completion executor — is a closure over
	// this session's state. It makes NO folding decisions of its own on the hook path.
	const liveHost = new LiveConductorHost({
		truth: () => truth,
		broadcast: (m) => broadcast(m),
		sendToConductor: (m) => {
			if (conductorWs && conductorWs.readyState === 1) send(conductorWs, m);
		},
		sendToSocket: (socket, m) => {
			const ws = socket as WebSocket | null;
			if (ws && ws.readyState === 1) send(ws, m);
		},
		mintToken: () => crypto.randomBytes(16).toString("hex"),
		spawnRunner: (entryFile, env) => spawnRunner(entryFile, env),
		runCompletion: (req, signal) => runCompletion(req, signal),
		spawnEnv: () => ({ port, sessionKey: sessionId, home: HOME }),
		now: () => Date.now(),
	});

	/** Resolve a thermocline-style runner file on disk (repo checkout only this phase), or null. */
	function resolveRunnerPath(entryFile: string): string | null {
		try {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const p = path.resolve(here, "..", "conductors", "thermocline", entryFile);
			return fs.existsSync(p) ? p : null;
		} catch {
			return null;
		}
	}

	/**
	 * Launch a spawn conductor's runner in its own Node process (NOT detached, so it dies with pi),
	 * piping stderr into a bounded buffer surfaced via `conductorStatus` on an unexpected exit. The
	 * returned handle's `kill()` sends SIGTERM first, SIGKILL on a second call — the grace loop lives
	 * in `LiveConductorHost`. Returns null when the runner file is absent (thermocline then simply
	 * doesn't appear in the catalog, and a defensive `select` of it undoes cleanly).
	 */
	function spawnRunner(entryFile: string, env: Record<string, string>): SpawnedRunner | null {
		const runnerPath = resolveRunnerPath(entryFile);
		if (!runnerPath) return null;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, [runnerPath], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return null;
		}
		let stderrBuf = "";
		const STDERR_CAP = 8 * 1024;
		child.stderr?.on("data", (d: Buffer) => {
			stderrBuf = (stderrBuf + d.toString()).slice(-STDERR_CAP);
		});
		let sigterm = false;
		return {
			kill(): void {
				try {
					child.kill(sigterm ? "SIGKILL" : "SIGTERM");
					sigterm = true;
				} catch {
					/* already dead */
				}
			},
			onExit(cb): void {
				child.on("exit", (code) => cb({ code, stderr: stderrBuf }));
				child.on("error", () => cb({ code: null, stderr: stderrBuf }));
			},
		};
	}

	/**
	 * The out-of-band completion executor (ported from dc037bc's completeRequest handler): resolve
	 * the live model's API key, lazily import pi-ai, clamp `maxOutputTokens` to the model's ceiling,
	 * and race the provider call against an abortable timeout. NEVER on the `context` hook path — the
	 * conductor awaits it off to the side. A process-wide semaphore bounds concurrent spend.
	 */
	async function runCompletion(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
		if (typeof req.prompt !== "string" || req.prompt.length === 0) throw new Error("missing or empty prompt");
		if (req.maxOutputTokens !== undefined && (!Number.isSafeInteger(req.maxOutputTokens) || req.maxOutputTokens <= 0))
			throw new Error("maxOutputTokens must be a positive safe integer");
		if (activeCompletions >= MAX_CONCURRENT_COMPLETIONS) throw new Error(`too many concurrent completions in flight (max ${MAX_CONCURRENT_COMPLETIONS})`);
		activeCompletions++;
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		if (signal.aborted) abort.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
		const timeoutError = new Error(`completion timed out after ${COMPLETION_TIMEOUT_MS}ms`);
		let timer: ReturnType<typeof setTimeout> | null = null;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				abort.abort(timeoutError);
				reject(timeoutError);
			}, COMPLETION_TIMEOUT_MS);
			(timer as { unref?: () => void }).unref?.();
		});
		// Non-null only AFTER complete() has actually launched provider work. A client-facing timeout
		// aborts that work and settles this call, but the concurrency slot stays occupied until the
		// underlying provider promise confirms settlement — an adapter that ignores AbortSignal must
		// not let spend accounting reopen a slot while its call is still burning tokens (issue: the
		// `finally` fires when Promise.race settles, i.e. on timeout BEFORE providerCall settles).
		let providerSettlement: Promise<void> | null = null;
		try {
			const ctx = latestCtx;
			const m = latestModelObj ?? (ctx?.model as any);
			if (!ctx || !m) throw new Error("no model available");
			const auth = await Promise.race([(ctx as any).modelRegistry.getApiKeyAndHeaders(m), deadline]);
			if (!auth?.ok) throw new Error(`could not resolve API key: ${auth?.error ?? "unknown"}`);
			const complete: CompletionFunction = dependencies.complete ?? (await Promise.race([import("@earendil-works/pi-ai" as any), deadline])).complete;
			const context = {
				...(typeof req.system === "string" ? { systemPrompt: req.system } : {}),
				messages: [{ role: "user" as const, content: req.prompt, timestamp: Date.now() }],
			};
			let maxTokens: number | undefined;
			if (typeof req.maxOutputTokens === "number") {
				const ceiling = Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : undefined;
				maxTokens = ceiling !== undefined ? Math.min(req.maxOutputTokens, ceiling) : req.maxOutputTokens;
			}
			const providerCall = complete(m, context, { apiKey: auth.apiKey, headers: auth.headers, signal: abort.signal, ...(maxTokens !== undefined ? { maxTokens } : {}) });
			// Consume either outcome for cleanup without changing the result used below.
			providerSettlement = providerCall.then(() => {}, () => {});
			const result = await Promise.race([providerCall, deadline]);
			let text = "";
			if (Array.isArray(result.content))
				text = result.content.filter((p: any) => p?.type === "text").map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
			return {
				text,
				model: result.model,
				inputTokens: typeof result.usage?.input === "number" ? result.usage.input : undefined,
				outputTokens: typeof result.usage?.output === "number" ? result.usage.output : undefined,
			};
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			// Release the concurrency slot only when the provider call itself settles; if we timed out
			// or failed before provider work ever launched, release immediately (there is nothing in
			// flight to keep the slot for).
			const release = (): void => {
				activeCompletions--;
			};
			if (providerSettlement) void providerSettlement.then(release);
			else release();
		}
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
		// lastHoldMs/holdTimeouts (protocol v13) are the REAL wire-departing hold telemetry now: how
		// long the host held the departing wire for the attached conductor's last-moment proposal on
		// the most recent hook, and how many holds have timed out over the session. Both stay 0 while
		// no conductor is attached (no hold is ever fired), so a no-conductor session is unchanged.
		broadcast({ type: "telemetry", lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, hookCount, lastHoldMs: liveHost.lastHoldMs, holdTimeouts: liveHost.holdTimeouts });
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
	 * ASYNC (fs.promises), not fs.*Sync: this runs on the same event loop as the `context` hook,
	 * which is now a LOCAL, synchronous reconcile against the in-process Truth (no plan round
	 * trip) that must stay fast — disk I/O on that path is a documented invariant violation. A
	 * browser tab polls this endpoint every second; synchronous directory/file I/O here would
	 * still share that event loop and add avoidable jitter ahead of the next model call. The
	 * async form yields between files instead.
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
		// Keep the FULL model object — an out-of-band completion needs it (apiKey resolution, the
		// maxTokens ceiling), not just the id string. `model: "current"` then follows a just-selected
		// model immediately instead of waiting for the next `context` hook to refresh `latestCtx`.
		latestModelObj = m;
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
						telemetry: { hookCount, lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, hookErrors, foldingEnabled },
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

		// PHASE C: a conductor-role socket is authorized SOLELY by the single-use pending attach token
		// the host minted when it spawned this runner — role confers NO privilege on its own. It skips
		// EVERY GUI trust branch (native no-Origin, Tauri origin, cookie, sibling probe): a hostile
		// page (or a stray native client) that guesses `?role=conductor` still needs the unguessable
		// token, and the token is valid only for the exact spawn currently awaiting its runner. The
		// GUI path below is byte-identical to before (PR #72 hardening must not regress).
		if (roleFromUrl(req.url) === "conductor") {
			const pending = liveHost.pendingAttachToken;
			const ok = !!pending && token === pending;
			cb(ok, ok ? undefined : 403, ok ? undefined : "conductor attach token required");
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
			// PHASE C: a conductor-role socket must consume its single-use attach token before it is
			// treated as the active conductor (the token was already verified at upgrade time; consume
			// it here so a re-dial with the same token is rejected). It STILL joins `clients` and gets
			// the same hello/snapshot/event stream as a GUI — a remote conductor is a replica.
			if (role === "conductor") {
				let token: string | null = null;
				try {
					token = new URL(req?.url || "/", "http://accordion.local").searchParams.get("token");
				} catch {
					/* verifyWsUpgrade already rejected a malformed target */
				}
				if (!liveHost.acceptConductorSocket(ws, token)) {
					try { ws.close(); } catch { /* ignore */ }
					return;
				}
				conductorWs = ws;
			}
			// Bring the Truth up to date with the session's current history BEFORE snapshotting.
			// On a resumed/loaded session no hook has fired yet, so read straight from the session
			// manager. This runs before `ws` joins `clients`, so any resulting append events reach
			// only the ALREADY-connected clients — the new client gets the up-to-date snapshot next.
			//
			// This intentionally still runs even when `truth` already exists (not gated behind
			// `!truth`, i.e. NOT bootstrap-only): `readSessionMessages` reads pi's CURRENT
			// `sessionManager` state, which reflects tree-nav (`session_before_tree`/`session_tree`,
			// which this extension does not hook) the instant it happens — the only other way a
			// tree-nav jump surfaces is the next `context`/`agent_end` hook. Gating this to
			// bootstrap-only would leave a client that attaches right after a tree-nav (before the
			// next model call) looking at the stale pre-nav branch. A second client attaching mid-
			// session can still spuriously trip `ingestMessages`' divergence check against
			// `lastMessages` here, forcing a rebuild — but `buildTruth`/`Truth.rebuildFrom` now
			// preserves every surviving block's overlay and the host's dials across that rebuild, so
			// the rebuild this triggers no longer wipes the first client's folds/pins/groups/dials
			// (review finding).
			const history = readSessionMessages(latestCtx);
			if (history.length) ingestMessages(history);

			// hello advertises the conductor catalog (thermocline only if its runner resolves on disk).
			send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, role, meta, conductors: catalogMeta((entryFile) => resolveRunnerPath(entryFile) !== null) });
			if (truth) send(ws, { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
			// P1-6: a freshly attached REMOTE conductor gets an initial turn-committed right AFTER its
			// snapshot — by now the spawned SDK has hydrated its replica and run `conductor.attach`, so its
			// listener is live and this drives an immediate pass over existing state instead of idling
			// until the next real turn. (The in-process seam fires its own initial pass inside `select`.)
			if (role === "conductor" && truth) liveHost.fireInitialTurnCommitted();
			// After the snapshot, a (re)connecting client learns who — if anyone — is driving, plus any
			// cached conductor status line, so it never renders from a locally tracked guess.
			const activeMeta = liveHost.activeMeta();
			if (activeMeta) send(ws, { type: "conductorState", active: activeMeta });
			const cachedStatus = liveHost.cachedStatus();
			if (cachedStatus) send(ws, cachedStatus);
			// Seed the client's latency badge with current telemetry (blank until the first hook otherwise).
			send(ws, { type: "telemetry", lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, hookCount, lastHoldMs: liveHost.lastHoldMs, holdTimeouts: liveHost.holdTimeouts });
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
				if (role === "conductor") {
					// A conductor replica: propose / completeRequest / setConductorStatus route to the
					// live host (which verifies this is the ACTIVE conductor socket), plus resnapshot.
					if (msg?.type === "resnapshot") {
						if (truth) send(ws, { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
					} else {
						liveHost.handleConductorMessage(ws, msg);
					}
					return;
				}
				// The GUI client→server message: a remote-control command. The host applies it to the
				// authoritative Truth (emitting events to ALL clients) and replies with the per-op
				// results + resulting rev. There is NO optimistic apply on the client — the replica
				// mutates only via the echoed event stream, so a command and its events can't race.
				if (msg?.type === "command" && typeof msg.seq === "number" && msg.cmd && typeof msg.cmd === "object") {
					const { results, rev } = applyCommand(msg.cmd as WireCommand);
					send(ws, { type: "commandResult", seq: msg.seq, results, rev });
				} else if (msg?.type === "resnapshot") {
					// The replica diverged (rev mismatch) or saw a `reset` — hand it a fresh snapshot.
					if (truth) send(ws, { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
				}
			});
			const drop = () => {
				clients.delete(ws);
				if (role === "conductor") {
					if (conductorWs === ws) conductorWs = null;
					liveHost.handleSocketClose(ws); // a clean detach if this was the active conductor
				}
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

	// ── Phase B host helpers (the truth lives here now) ─────────────────────────

	/** Parse the client role from the connect URL (`?role=conductor`); default "gui". */
	function roleFromUrl(url: string | undefined): Role {
		try {
			const r = new URL(url || "/", "http://accordion.local").searchParams.get("role");
			return r === "conductor" ? "conductor" : "gui";
		} catch {
			return "gui";
		}
	}

	/** SessionMeta for a Truth built from the current discovery meta. */
	function metaForTruth(): SessionMeta {
		return { format: "pi", title: meta.title, cwd: meta.cwd, model: meta.model };
	}

	/** The current folding arm, echoed in snapshots + on toggle. Only broadcasts on a real change. */
	function setFolding(on: boolean): void {
		if (foldingEnabled === on) return;
		foldingEnabled = on;
		broadcast({ type: "folding", enabled: foldingEnabled });
	}

	/**
	 * (Re)build the authoritative Truth from a full messages array. Subscribes the event forwarder
	 * so every subsequent Truth mutation streams to clients as a replayable `event`. Uses
	 * `Truth.rebuildFrom` so a structural-divergence rebuild (the CURRENT `truth`, captured as
	 * `prev` below, is non-null) carries over every surviving block's overlay, `birthFolded`
	 * membership, scalar dials, and fully-surviving groups from the truth being replaced — a
	 * rebuild must reconcile pi's messages, not silently wipe every human/host fold, pin, group,
	 * and dial (review finding). `prev === null` (session_start already nulled `truth`) skips
	 * carryover: a brand-new session has nothing to preserve. Sets `wireAttached` + the known
	 * context window BEFORE subscribing so those internal bumps ride the snapshot, not a stray event.
	 */
	function buildTruth(messages: PiMessage[]): void {
		if (unsubTruth) {
			unsubTruth();
			unsubTruth = null;
		}
		const prev = truth;
		const blocks = linearize(messages).map(wireToBlock);
		const t = Truth.rebuildFrom(prev, { meta: metaForTruth(), blocks, lineCount: 0, skipped: 0 });
		t.wireAttached = true; // a live pi session is always a live wire (durability-aware accounting)
		if (contextWindow != null) {
			t.setContextWindow(contextWindow);
			// Snap the budget to the model window only on the FIRST build (no prior human dial to
			// respect). A rebuild already carried `prev`'s budget via `rebuildFrom` — re-snapping it
			// here on every divergence would silently undo a human's custom budget (part of the same
			// finding: a rebuild must preserve the human's dials, not just per-block overlay).
			if (!prev) t.setBudget(contextWindow);
		}
		// One subscription drives BOTH the client fan-out (replayable events) and the in-process
		// conductor's HostEvent stream — the same TruthEvent, projected two ways.
		unsubTruth = t.onEvent((e) => {
			forwardTruthEvent(e);
			liveHost.dispatchTruthEvent(e);
		});
		truth = t;
		lastMessages = messages;
	}

	/**
	 * Rebuild on structural DIVERGENCE (compaction / fork / tree-nav / another extension rewriting
	 * messages). Counts the rebuild in telemetry and forces every connected client to resnapshot.
	 * The first build (session_start, `truth === null`) is NOT a divergence rebuild.
	 */
	function rebuildTruth(messages: PiMessage[]): void {
		const isDivergence = truth !== null;
		buildTruth(messages);
		if (isDivergence) {
			rebuilds++;
			broadcast({ type: "snapshot", state: serializeSnapshot(truth!, foldingEnabled) });
			// The Truth object was replaced — an in-process conductor rebuilds its tracked desired
			// state from resync; a remote replica gets the forced resnapshot broadcast above.
			liveHost.dispatchResync();
		}
	}

	/**
	 * Cheap CONTENT fingerprint for one message, compared alongside `messageInfo`'s durable ids in
	 * `sameMessageIdentity` (E1, external review round). Durable ids alone prove only the SHAPE
	 * (which blocks exist, in what order) is unchanged — they say nothing about whether pi or a peer
	 * extension rewrote a block's TEXT in place while keeping the same anchor (same timestamp /
	 * responseId / toolCallId). Without this, `Truth.append`'s id-based idempotency keeps the OLD
	 * text forever: the GUI, `recall`, and a folded block's wire digest would all silently keep
	 * serving stale content even though the model itself now sees something new.
	 *
	 * Deliberately sums `string.length`, never hashes bytes. Every JS string already carries its
	 * length precomputed, so this is one property read per text-bearing part — the SAME O(parts)
	 * walk `messageInfo` already does to build `ids`, not an O(text size) pass over the actual
	 * characters. A length MISMATCH is conclusive proof of a content change and short-circuits the
	 * whole per-hook reconcile immediately, at the same cost class as the existing id comparison.
	 *
	 * A length MATCH is not conclusive: a same-length in-place rewrite (e.g. a fixed-width redaction
	 * placeholder swapped in for the original text) would slip through undetected. That gap is
	 * accepted deliberately rather than hashing full text on every hook: hashing would require
	 * reading every character of every already-ingested message on every single `context` call, even
	 * for the overwhelming common case where NOTHING changed — reintroducing exactly the
	 * O(total-context-size) hot-path cost ADR 0021 eliminated (the hook must stay local, synchronous,
	 * and sub-ms, independent of how large the session has grown). Length alone already catches every
	 * rewrite this finding's own scenario describes — in-place redaction/summarization/truncation
	 * changes size in virtually every real case. See smoke.mjs's "content mutation, same ids"
	 * scenario, which also measures that the hook stays well under 100ms with this check in place.
	 *
	 * Deliberately EXCLUDES a `toolCall` part's `arguments` object from the sum: arguments are a
	 * structured value, not a string, and only `JSON.stringify` would yield a length — paid on every
	 * hook, that reintroduces the very O(size) cost this function exists to avoid, for a narrower
	 * rewrite class (mutated tool-call arguments with an unchanged position) than the
	 * tool_result/text/thinking rewrites the finding calls out.
	 */
	function contentFingerprint(m: PiMessage): number {
		let n = 0;
		const add = (s: unknown): void => {
			if (typeof s === "string") n += s.length;
		};
		const addContent = (content: unknown): void => {
			if (typeof content === "string") add(content);
			else if (Array.isArray(content)) for (const p of content) add((p as { text?: unknown } | null)?.text);
		};
		switch (m.role) {
			case "user":
				addContent(m.content);
				break;
			case "assistant": {
				const parts = Array.isArray(m.content) ? m.content : [];
				for (const b of parts as Array<{ type?: string; text?: unknown; thinking?: unknown }>) {
					if (b?.type === "text") add(b.text);
					else if (b?.type === "thinking") add(b.thinking);
					// toolCall arguments intentionally excluded — see the doc comment above.
				}
				break;
			}
			case "toolResult":
				addContent(m.content);
				break;
			default:
				add(m.summary);
		}
		return n;
	}

	/**
	 * Two messages share identity iff they emit the same durable block ids (cheap; no token work) AND
	 * the same content fingerprint (E1: catches a same-id in-place rewrite — see `contentFingerprint`).
	 */
	function sameMessageIdentity(a: PiMessage, b: PiMessage, i: number): boolean {
		if (a.role !== b.role) return false;
		const ia = messageInfo(a, i).ids;
		const ib = messageInfo(b, i).ids;
		if (ia.length !== ib.length) return false;
		for (let k = 0; k < ia.length; k++) if (ia[k] !== ib[k]) return false;
		if (contentFingerprint(a) !== contentFingerprint(b)) return false;
		return true;
	}

	/** Linearize `messages.slice(from)` with globally-correct numbering and append it to the Truth. */
	function appendSuffix(messages: PiMessage[], from: number): void {
		if (!truth) return;
		const lastB = truth.blocks[truth.blocks.length - 1];
		const orderStart = truth.blocks.length; // orders are contiguous from 0 → next order = count
		const turnStart = lastB ? lastB.turn : 0;
		const fresh = linearize(messages.slice(from), orderStart, turnStart).map(wireToBlock);
		truth.append(fresh); // idempotent by id; emits `appended` → forwarded to clients
	}

	/**
	 * Reconcile pi's messages against the Truth by a cheap durable-id walk: if `messages` is our
	 * last array plus a new suffix, linearize ONLY the suffix and append (O(Δ) text work); if it
	 * diverges structurally, REBUILD. Mutations broadcast automatically via the Truth subscription.
	 */
	function ingestMessages(messages: PiMessage[]): void {
		if (!truth) {
			rebuildTruth(messages);
			return;
		}
		const prev = lastMessages;
		let diverged = messages.length < prev.length;
		if (!diverged) {
			for (let i = 0; i < prev.length; i++) {
				if (!sameMessageIdentity(prev[i], messages[i], i)) {
					diverged = true;
					break;
				}
			}
		}
		if (diverged) {
			rebuildTruth(messages);
			return;
		}
		if (messages.length > prev.length) appendSuffix(messages, prev.length);
		lastMessages = messages;
	}

	/**
	 * Append ONE just-finished message (message_end) to the Truth immediately — this is what kills
	 * the one-turn lag. Deduped on the message's durable ids so a re-fire or an already-appended
	 * message is skipped (and `lastMessages` is extended so the next context prefix still matches).
	 */
	function ingestFinishedMessage(msg: PiMessage): void {
		if (!truth) return;
		const ids = messageInfo(msg, 0).ids;
		if (!ids.length) return;
		if (ids.every((id) => truth!.get(id))) return; // already represented → nothing to do
		appendSuffix([...lastMessages, msg], lastMessages.length);
		lastMessages = [...lastMessages, msg];
	}

	/** Apply a client command to the authoritative Truth; returns the per-op results + resulting rev. */
	function applyCommand(cmd: WireCommand): { results: OpResult[]; rev: number } {
		if (!truth) return { results: [], rev: 0 };
		switch (cmd.kind) {
			case "ops": {
				// Guard host-only ops (`freeze`) at the GUI wire entry: an authenticated client must not
				// be able to seize a conductor's strategy folds through the ungated kill switch. A smuggled
				// freeze is stripped and reported back as a `locked` clamp in the commandResult.
				const t = truth;
				const r = applyGuardingHostOnly(Array.isArray(cmd.ops) ? cmd.ops : [], (allowed) => t.apply(allowed, "you"));
				return { results: r.results, rev: r.rev };
			}
			case "setBudget":
				truth.setBudget(cmd.value);
				return { results: [], rev: truth.rev };
			case "setProtect":
				truth.setProtect(cmd.value);
				return { results: [], rev: truth.rev };
			case "setFolding":
				setFolding(!!cmd.value);
				return { results: [], rev: truth.rev };
			case "selectConductor":
				// GUI-only (a conductor socket never reaches applyCommand — its messages route to
				// handleConductorMessage). Drives the host's attach/detach; state arrives via events +
				// the conductorState broadcast, so nothing to return here beyond the current rev.
				liveHost.select(cmd.id);
				return { results: [], rev: truth.rev };
			default:
				return { results: [], rev: truth.rev };
		}
	}
	// ── lifecycle ──────────────────────────────────────────────────────────────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// Tear down the OLD session's Truth + event forwarder before building the new one; a
		// session swap invalidates the whole context state (a fresh Truth is authoritative). Detach
		// any attached conductor first (kills a spawned runner, clears its locks off the old Truth,
		// aborts in-flight completions) — a conductor is per-session and never carries across a swap.
		liveHost.shutdown();
		conductorWs = null;
		if (unsubTruth) {
			unsubTruth();
			unsubTruth = null;
		}
		truth = null;
		lastMessages = [];
		// E2 (external review round): folding is OPT-IN and OFF by default PER SESSION — reset the
		// arm on every `session_start`, regardless of `_event.reason` ("startup"/"reload"/"new"/
		// "resume"/"fork"). Everything else this handler touches (Truth, `lastMessages`, `meta`, the
		// conductor, and — a few lines below — `sessionId` itself) is ALREADY unconditionally reset
		// here for every reason, including a mere "reload": pi's own types note `previousSessionFile`
		// is present only for "new"/"resume"/"fork", implying "reload" re-enters the SAME session, yet
		// this handler has never special-cased it — it still tears down and rebuilds the authoritative
		// Truth from scratch and mints a brand-new `sessionId`. Leaving `foldingEnabled` as the one
		// piece of state that survives a reload would be an inconsistent, easy-to-miss exception to
		// that existing behavior, and would violate the per-session opt-in invariant on the case this
		// finding named explicitly. `setFolding` only broadcasts when the value actually changes, so an
		// already-attached client whose GUI toggle shows "on" gets an explicit `folding:false` to
		// resync it — connected clients are NOT dropped across a session_start, so without this a
		// client's toggle could silently drift from the true (now-reset) internal state.
		setFolding(false);
		latestCtx = ctx;
		sessionId = `s-${process.pid}-${Date.now()}`;
		startedAt = Date.now();
		try {
			meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", contextWindow: null, format: "pi" };
		} catch {
			/* keep defaults */
		}
		refreshFromCtx(ctx); // model / context window may be known already
		// Build the authoritative Truth from the session's current history. For a fresh session
		// this is []; for a RESUMED/loaded session it is the full prior conversation, born SENT
		// (the Truth constructor marks all loaded blocks sent). A client that attaches before any
		// turn still gets a correct snapshot.
		buildTruth(readSessionMessages(ctx));
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
		if (!attached()) return;

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

	// ── the loop: LOCAL reconcile + optional serialize + telemetry ──────────────
	// Phase B: pi's `context` hook is a LOCAL operation against the in-process Truth. No client
	// round trip, no await, no disk I/O. Returning `undefined` passes pi's messages through
	// unchanged (the default when folding is disabled); an explicit `{ messages }` replaces them.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const t0 = Date.now();
		// Invariant: this hook must NEVER break a model call. Everything that can throw (a bad
		// parse, an unexpected message shape, a Truth bug) is guarded — on any throw we fall back to
		// passthrough (`ret` stays undefined) so pi proceeds with its own original messages,
		// unmodified. Timing (below) still covers the whole guarded body, error or not.
		let ret: { messages: AgentMessage[] } | undefined;
		try {
			latestCtx = ctx;
			// Refresh model/usage in memory only — NO disk I/O on the model-call critical path.
			refreshFromCtx(ctx);
			const messages = event.messages as unknown as PiMessage[];
			// (a) Reconcile pi's messages against the Truth: append a new suffix, or rebuild on
			//     structural divergence (both broadcast to clients via the Truth subscription).
			ingestMessages(messages);
			if (truth) {
				// (b) PHASE C: the wire-departing hold. ONLY paid when folding is armed AND the attached
				//     conductor declares a hold window — the sync fast path (no conductor / no hold /
				//     folding off) never awaits anything, keeping a no-conductor session byte-identical
				//     to pre-Phase-C. This is where a conductor's last-moment (birth-)fold lands before
				//     the wire is serialized. No disk I/O; the spawn/kill bridge is never on this path.
				const holdMeta = liveHost.activeMeta();
				if (foldingEnabled && holdMeta && holdMeta.holdWireUpToMs > 0) {
					await liveHost.fireWireDepartingAndAwaitHold();
				}
				// (c) If folding is armed, serialize the wire from the Truth and replace; else passthrough.
				if (foldingEnabled) {
					ret = { messages: truth.serializeWire(messages) as unknown as AgentMessage[] };
				}
			}
		} catch (err) {
			hookErrors++;
			console.error("[accordion] context hook failed; passing messages through unmodified:", err);
			ret = undefined;
		} finally {
			// (d) markSent through the last block — GUARANTEED on both the success AND the error path
			// (E3, external review round). Invariant: whatever this hook actually let through to the
			// model counts as sent. On the happy path `ret` may hold the serialized replacement, but
			// either way (folding on or off) pi ends up delivering every block up to the Truth's current
			// tail — the range markSent covers is correct regardless of which branch built `ret`. On the
			// error path `ret` stays `undefined`, so pi sends `event.messages` RAW AND UNMODIFIED — every
			// block in the Truth mirroring that array still departed to the model whole. Previously
			// markSent lived only inside the try, AFTER the risky work (ingestMessages / the wire-
			// departing hold / serializeWire) — a throw anywhere in there returned raw passthrough
			// (those messages DO reach the model) but skipped markSent, so already-departed blocks were
			// later misclassified as never-sent and wrongly treated as still birth-foldable (`canFold`'s
			// `!sent(b)` exemption). Moving it to `finally` makes it run on every exit path. Guarded in
			// its own try/catch so a throw HERE (Truth in a genuinely broken state) still can't escape
			// and break the model call — the hook's return value is already decided either way.
			try {
				if (truth) {
					const last = truth.blocks[truth.blocks.length - 1];
					if (last) truth.markSent(last.order);
				}
			} catch (err) {
				console.error("[accordion] context hook markSent (finally) failed:", err);
			}
		}
		// (e) Measure the whole hook (guarded body included, hold window and all) and stream it as
		// telemetry — lastHoldMs/holdTimeouts (from the live host) ride alongside the hook duration.
		recordHook(Date.now() - t0);
		broadcastTelemetry();
		return ret;
	});

	// ── model swap: keep the context window in lockstep ─────────────────────────
	// `/model` fires `model_select` immediately, carrying the NEW model. Adopt its context window
	// into the Truth right away (emits a `config` event to every client) so the budget tracks the
	// swap without waiting for the next model call.
	pi.on("model_select", (event) => {
		applyModel(event?.model as { id?: string; contextWindow?: number } | undefined);
		if (truth && contextWindow != null) truth.setContextWindow(contextWindow);
	});

	// ── turn settled: the canonical re-plan trigger for a turn-based conductor ───
	// `turn_end` fires after each LLM turn. It is the host-lifecycle equivalent of
	// `TestHost.commitTurn` — an attached conductor (in-process) or the remote replica (over the
	// wire) treats it as the moment to re-run its pass. Purely a notification; folding still happens
	// only at `context`, and there is no conductor attached ⇒ this is a no-op.
	pi.on("turn_end", () => {
		if (!truth) return;
		const last = truth.blocks[truth.blocks.length - 1];
		liveHost.fireTurnCommitted(last ? last.turn : 0, truth.rev);
	});

	// ── committed streaming: append finished messages to the Truth immediately ──
	// `context` only fires BEFORE a model call (messages going IN); `agent_end` fires once at loop
	// end. `message_end` fires the moment each message is finalized — including assistant replies
	// mid-tool-loop — so appending here (idempotent by id) is what KILLS the one-turn lag: the
	// reply's blocks enter the Truth (and stream to every client) the instant they exist, not at
	// the next model call. View-only: folding still happens only at `context`.
	pi.on("message_end", (event) => {
		// Sweep all active ghosts (invariant #2, ADR 0003) BEFORE the committed blocks stream, so a
		// client swaps its ghost placeholders for the real blocks in the same tick.
		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		const msg = event.message as unknown as PiMessage;
		if (msg) ingestFinishedMessage(msg);
	});

	// ── loop-end backstop: reconcile the final full array ───────────────────────
	// `agent_end` carries the FULL message array; reconciling it catches anything message_end
	// missed (e.g. a message that finished with no client attached) and keeps `lastMessages`
	// authoritative for the next turn. Idempotent — the delta is usually empty by now.
	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		ingestMessages(event.messages as unknown as PiMessage[]);
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
		// Tear the attached conductor down FIRST (while the Truth still exists): SIGTERM→grace→SIGKILL
		// any spawned runner, abort in-flight completions, release any pending hold. The freeze kill
		// switch runs against the live Truth before we null it below.
		liveHost.shutdown();
		conductorWs = null;
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		deleteEntry(); // stop advertising — the app drops our row immediately
		// Tear down the Truth + its event forwarder, and close every client.
		if (unsubTruth) {
			unsubTruth();
			unsubTruth = null;
		}
		truth = null;
		for (const ws of clients.keys()) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
		clients.clear();
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
			const blockCount = truth ? truth.blocks.length : 0;
			const lines = [
				action.text,
				`Live link: ${clients.size} client(s) · port ${portStatus} · ${blockCount} blocks · folding ${foldingEnabled ? "on" : "off"}`,
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
	// Phase B: resolved LOCALLY against the in-process Truth (no client needed). The unfolded
	// block becomes standing-open (sticky, provenance "agent") and its content returns to the
	// model on the NEXT `context` hook — it simply no longer appears in the fold serialization.
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
			// Nothing rides the wire folded unless folding is armed, so there is nothing to unfold.
			if (!truth || !foldingEnabled) {
				return { content: [{ type: "text", text: "Accordion isn't folding your context right now, so nothing is folded to restore — it is already full." }] };
			}
			const res = resolveUnfold(truth, codes); // LOCAL: mutates the Truth (broadcasts to clients)
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
	// what is standing in the agent's context — no override is created, the block stays folded.
	// Phase B: resolved LOCALLY against the Truth (a pure read, never a mutation). Because it
	// changes no state it is never lockable — the net that keeps a locked `unfold` from blinding
	// the agent. A `recall` observation is broadcast so clients/conductors can see the read.
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
			if (!truth) {
				return { content: [{ type: "text", text: "Accordion isn't attached, so nothing in your context is folded right now — it is already full." }] };
			}
			const res = resolveRecall(truth, codes); // LOCAL, pure read — never mutates fold state
			// Surface the read so clients/conductors can observe it (no Truth state changed). The
			// broadcast reaches conductor-role sockets too (a remote conductor derives its recall
			// observation from it); an in-process conductor gets the derived HostEvent via dispatchRecall.
			if (res.restored.length) {
				const ids = res.restored.flatMap((r) => r.ids);
				broadcast({ type: "recall", ids, by: "agent" });
				liveHost.dispatchRecall(ids, "agent");
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

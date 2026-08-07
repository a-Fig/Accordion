/*
 * liveHost.ts — `LiveConductorHost`, the in-extension host that attaches a resident conductor to
 * the authoritative live Truth (Phase C).
 *
 * It plays two roles at once:
 *   1. A `ConductorHost` (the frozen conductor-v2 contract, `./contract`) handed to an IN-PROCESS
 *      conductor's `attach(host)` — `on` / `get` / `blocks` / `groups` / `textOf` / `stats` /
 *      `countTokens` / `digestOf` / `complete` / `setStatus` / `propose`, all reading/writing the
 *      one live Truth.
 *   2. The lifecycle host that the SAME contract's moments (turn-committed, wire-departing, resync,
 *      recall) reach a REMOTE (spawned) conductor over the wire — a remote conductor is a replica
 *      that derives blocks-appended/state-changed/resync from the normal event stream it already
 *      receives, so only `wireDeparting` and `turnCommitted` need explicit sends.
 *
 * Fully dependency-injected (`LiveHostDeps`) so it unit-tests with a mock Truth + mock sockets +
 * mock spawn, no WebSocket / child process / pi in sight.
 *
 * The single derivation of `HostEvent`s from the Truth is REUSED from `./hostAdapter` (never
 * re-derived) — the same functions `TestHost` and every shipped conductor are golden-tested against.
 */
import type { Truth, TruthStats } from "../truth";
import type { TruthEvent } from "../events";
import type { Actor } from "../types";
import type { Op, TxnResult } from "../ops";
import { applyGuardingHostOnly } from "../ops";
import type {
	ServerMessage,
	ActiveConductorMeta,
	ConductorStatusMessage,
	ProposeMessage,
	CompleteRequestMessage,
	SetConductorStatusMessage,
	HoldReleaseMessage,
	CancelCompleteMessage,
} from "../protocol";
import type { Conductor, ConductorHost, HostEvent, ViewBlock, GroupInfo, CompletionRequest, CompletionResult } from "./contract";
import { viewBlockOf, hostEventsFromTruthEvent, recallHostEvent, wireDepartingEvent } from "./hostAdapter";
import { entryById, type RegistryEntry } from "./registry";
import { estTokens } from "../tokens";
import { digest } from "../digest";

/** A spawned out-of-process runner handle. `kill()` first→SIGTERM, again→SIGKILL (extension-side). */
export interface SpawnedRunner {
	kill(): void;
	onExit(cb: (info?: { code?: number | null; stderr?: string }) => void): void;
}

/** Everything `LiveConductorHost` needs from the outside world (extension in prod, mocks in tests). */
export interface LiveHostDeps {
	/** The current authoritative Truth (or null before one exists). Read on every access. */
	truth: () => Truth | null;
	/** Broadcast to ALL connected clients (GUI + conductor replica). */
	broadcast(msg: ServerMessage): void;
	/** Send to the active conductor socket; a no-op if none is attached. */
	sendToConductor(msg: ServerMessage): void;
	/** Send to a SPECIFIC socket (the one that issued a request), regardless of which socket is
	 *  active now; a no-op if that socket is gone/closed. Used to route a late `completeResult` back
	 *  to its originating conductor, never to whoever attached after an A→B swap. */
	sendToSocket(socket: unknown, msg: ServerMessage): void;
	/** Mint a single-use bearer for a spawn conductor's WS attach. */
	mintToken(): string;
	/** Launch a spawn conductor's runner. Returns null if the runner is unavailable on this install. */
	spawnRunner(entryFile: string, env: Record<string, string>): SpawnedRunner | null;
	/** Run an out-of-band model completion off the hot path. Rejects on failure/unavailability. */
	runCompletion(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
	/** The spawn environment facts (loopback port, stable session key, persistence home). */
	spawnEnv(): { port: number; sessionKey: string; home: string };
	/** Monotonic-ish clock for measuring the hold window. */
	now(): number;
}

/** How long the host waits for a spawned runner to dial in before auto-detaching. */
const PENDING_ATTACH_MS = 10_000;
/** Grace between SIGTERM and SIGKILL when tearing a spawn child down. */
const GRACE_MS = 2_000;

const ZERO_STATS: TruthStats = {
	rev: 0,
	liveTokens: 0,
	fullTokens: 0,
	budget: 0,
	contextWindow: null,
	protectTokens: 0,
	protectedFromIndex: 0,
	blockCount: 0,
};

function isThenable(v: unknown): v is Promise<unknown> {
	return !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";
}

/** A cancellable timeout that resolves to `"timeout"` — used to bound a hold window. */
function timeoutMarker(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout>;
	const promise = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
		(timer as { unref?: () => void }).unref?.();
	});
	return { promise, cancel: () => clearTimeout(timer!) };
}

export class LiveConductorHost implements ConductorHost {
	private readonly deps: LiveHostDeps;

	// ── attachment state ────────────────────────────────────────────────────────
	private active: RegistryEntry | null = null;
	private mode: "in-process" | "spawn" | null = null;
	private inProcessConductor: Conductor | null = null;

	// ── in-process listener set (the ConductorHost.on subscribers) ────────────────
	private listeners = new Set<(e: HostEvent) => void | Promise<void>>();

	// ── spawn state ───────────────────────────────────────────────────────────────
	private spawnChild: SpawnedRunner | null = null;
	private conductorSocket: unknown = null;
	private pendingToken: string | null = null;
	private pendingAttachTimer: ReturnType<typeof setTimeout> | null = null;

	// ── in-flight completions (abortable on detach) ──────────────────────────────
	private completions = new Set<AbortController>();
	// Per-reqId completion controllers, so a conductor's `cancelComplete { reqId }` (v14, S7) can abort
	// the exact completion it started. Cleared alongside `completions` on detach.
	private completionsByReqId = new Map<number, AbortController>();

	// ── conductor display status (broadcast + cached for late-joining clients) ────
	private cachedStatusMsg: ConductorStatusMessage | null = null;

	// ── wire-departing hold (remote) ─────────────────────────────────────────────
	// `holdId` is minted per hold (monotonic `holdSeq`) and rides the `wireDeparting` message; the
	// remote conductor echoes it back in `holdRelease` to end exactly THIS hold (v14). The id acts as
	// the generation guard: a stale/unknown release — including one arriving after the hold already
	// timed out — never resolves a later hold.
	private holdWaiter: { holdId: number; resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
	private holdSeq = 0;
	private lastHoldMsValue = 0;
	private holdTimeoutsValue = 0;

	constructor(deps: LiveHostDeps) {
		this.deps = deps;
	}

	// ── telemetry read surface ────────────────────────────────────────────────────
	get lastHoldMs(): number {
		return this.lastHoldMsValue;
	}
	get holdTimeouts(): number {
		return this.holdTimeoutsValue;
	}
	get pendingAttachToken(): string | null {
		return this.pendingToken;
	}

	activeMeta(): ActiveConductorMeta | null {
		if (!this.active) return null;
		const e = this.active;
		return {
			id: e.id,
			label: e.label,
			description: e.description,
			locks: e.locks.slice(),
			tailTokens: e.tailTokens,
			holdWireUpToMs: e.holdWireUpToMs,
			remote: this.mode === "spawn",
		};
	}
	cachedStatus(): ConductorStatusMessage | null {
		return this.cachedStatusMsg;
	}

	// ── ConductorHost surface (for an IN-PROCESS conductor) ───────────────────────
	on(fn: (e: HostEvent) => void | Promise<void>): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	get(id: string): ViewBlock | undefined {
		const t = this.deps.truth();
		const b = t?.get(id);
		return t && b ? viewBlockOf(t, b) : undefined;
	}
	blocks(): readonly ViewBlock[] {
		const t = this.deps.truth();
		return t ? t.blocks.map((b) => viewBlockOf(t, b)) : [];
	}
	groups(): readonly GroupInfo[] {
		const t = this.deps.truth();
		return t ? t.groups.map((g) => ({ id: g.id, memberIds: g.memberIds.slice(), folded: g.folded, by: g.by ?? null, summary: g.digest })) : [];
	}
	textOf(id: string): string | null {
		return this.deps.truth()?.get(id)?.text ?? null;
	}
	stats(): TruthStats {
		return this.deps.truth()?.stats() ?? ZERO_STATS;
	}
	countTokens(text: string): number {
		return estTokens(text);
	}
	digestOf(id: string): string | null {
		const b = this.deps.truth()?.get(id);
		return b ? digest(b) : null;
	}
	async complete(req: CompletionRequest): Promise<CompletionResult> {
		const controller = new AbortController();
		this.completions.add(controller);
		if (req.signal) {
			if (req.signal.aborted) controller.abort();
			else req.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}
		try {
			return await this.deps.runCompletion(req, controller.signal);
		} finally {
			this.completions.delete(controller);
		}
	}
	setStatus(text: string | null, metrics?: Record<string, number | string | boolean>): void {
		this.setAndBroadcastStatus(text, metrics);
	}
	propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		// The contract's `propose` is async; an in-process conductor awaits it. The ops apply to the
		// live Truth SYNCHRONOUSLY on invocation (via `applyPropose`) — only the return wraps in a
		// resolved Promise. The remote-conductor wire path calls `applyPropose` directly instead
		// (`handleConductorMessage`), returning a `TxnResult` synchronously to echo over the socket.
		return Promise.resolve(this.applyPropose(txn.baseRev, txn.ops));
	}

	// ── select / attach / detach ──────────────────────────────────────────────────
	/**
	 * The `selectConductor` command handler. Detach-first (freeze→clearLocks→teardown→abort), then
	 * attach the chosen conductor: eager `setLocks` (ADR 0011 consent→baseline), then in-process
	 * `create()`+`attach(host)` OR spawn (mint token, launch runner, arm a 10s pending-attach guard).
	 * `id === null` / `"none"` detaches only.
	 */
	select(id: string | null): void {
		this.detachActive();
		const entry = entryById(id);
		if (!entry || entry.kind === "none") {
			this.deps.broadcast({ type: "conductorState", active: null });
			return;
		}
		const t = this.deps.truth();
		if (!t) {
			this.deps.broadcast({ type: "conductorState", active: null });
			return;
		}
		// Eager lock acquisition — the conductor owns its declared controls the moment it attaches.
		t.setLocks(entry.locks, entry.label, entry.tailTokens ?? 0);
		this.active = entry;
		if (entry.kind === "in-process") {
			this.mode = "in-process";
			const c = entry.create!();
			this.inProcessConductor = c;
			try {
				c.attach(this);
			} catch {
				/* a throwing attach must not crash select */
			}
			// P1-6: give the freshly attached conductor an immediate pass over the EXISTING state so it
			// doesn't idle until the next real turn settles. (The remote seam fires its initial
			// turnCommitted from the extension AFTER the conductor's snapshot is dispatched — see
			// `fireInitialTurnCommitted`.)
			this.fireInitialTurnCommitted();
		} else {
			this.mode = "spawn";
			const token = this.deps.mintToken();
			this.pendingToken = token;
			const child = this.deps.spawnRunner(entry.spawn!.entryFile, this.spawnEnvRecord(token));
			if (!child) {
				// Runner unavailable — undo the eager attach and report why.
				this.setAndBroadcastStatus(`${entry.label} runner is unavailable on this install.`);
				t.clearLocks();
				this.active = null;
				this.mode = null;
				this.pendingToken = null;
				this.deps.broadcast({ type: "conductorState", active: null });
				return;
			}
			this.spawnChild = child;
			child.onExit((info) => {
				if (this.spawnChild !== child) return; // an intentional kill already handled teardown
				const stderr = info?.stderr?.trim();
				const reason = stderr
					? `${entry.label} process exited: ${stderr.slice(-400)}`
					: `${entry.label} process exited unexpectedly (code ${info?.code ?? "?"}).`;
				this.autoDetach(reason);
			});
			this.pendingAttachTimer = setTimeout(() => {
				this.pendingAttachTimer = null;
				this.autoDetach(`${entry.label} runner did not attach within ${PENDING_ATTACH_MS / 1000}s.`);
			}, PENDING_ATTACH_MS);
			(this.pendingAttachTimer as { unref?: () => void }).unref?.();
		}
		this.deps.broadcast({ type: "conductorState", active: this.activeMeta() });
	}

	/** Consume the single-use attach token for a dialing spawn runner. Second use is rejected. */
	acceptConductorSocket(from: unknown, token: string | null): boolean {
		if (this.mode !== "spawn") return false;
		if (!this.pendingToken || token !== this.pendingToken) return false;
		this.pendingToken = null; // single-use
		if (this.pendingAttachTimer) {
			clearTimeout(this.pendingAttachTimer);
			this.pendingAttachTimer = null;
		}
		this.conductorSocket = from;
		return true;
	}

	/** The active conductor's socket closed — clean detach (kill switch + clearLocks + broadcast). */
	handleSocketClose(from: unknown): void {
		if (from !== this.conductorSocket) return; // a stale/old socket closing
		this.detachActive();
		this.deps.broadcast({ type: "conductorState", active: null });
	}

	/** Route a message from the active conductor socket. Ignored from any non-active socket. */
	handleConductorMessage(from: unknown, msg: unknown): void {
		if (this.mode !== "spawn" || from !== this.conductorSocket) return; // role/socket confers no privilege
		if (!msg || typeof msg !== "object") return;
		const m = msg as { type?: unknown };
		if (m.type === "propose" && typeof (msg as ProposeMessage).seq === "number") {
			const pm = msg as ProposeMessage;
			const ops = Array.isArray(pm.ops) ? pm.ops : [];
			const r = this.applyPropose(typeof pm.baseRev === "number" ? pm.baseRev : undefined, ops);
			this.deps.sendToConductor({ type: "proposeResult", seq: pm.seq, rev: r.rev, results: r.results });
			// v14 (P1-2): a `propose` NO LONGER releases the wire-departing hold — the dedicated
			// `holdRelease` message does. A propose here (even empty-ops) is just an ordinary proposal, so
			// a background tick's propose racing the hold can't release it out from under the handler's
			// last-moment fold.
		} else if (m.type === "holdRelease" && Number.isSafeInteger((msg as HoldReleaseMessage).holdId)) {
			// Release the departing wire ONLY for the CURRENT hold; a stale/unknown id — including a
			// release that lands after this hold already timed out — is ignored by the generation guard.
			this.releaseHoldById((msg as HoldReleaseMessage).holdId);
		} else if (m.type === "completeRequest" && Number.isSafeInteger((msg as CompleteRequestMessage).reqId)) {
			this.handleCompleteRequest(from, msg as CompleteRequestMessage);
		} else if (m.type === "cancelComplete" && Number.isSafeInteger((msg as CancelCompleteMessage).reqId)) {
			// S7: forward the conductor's `complete()` abort to the in-flight completion for this reqId.
			// An unknown/settled reqId is a no-op (it already resolved, or never existed on this socket).
			const controller = this.completionsByReqId.get((msg as CancelCompleteMessage).reqId);
			if (controller) controller.abort();
		} else if (m.type === "setConductorStatus") {
			const sm = msg as SetConductorStatusMessage;
			this.setAndBroadcastStatus(typeof sm.text === "string" ? sm.text : null, sm.metrics);
		}
		// `resnapshot` from a conductor replica is served by the extension (it owns the snapshot).
	}

	/** Tear down whatever is attached: freeze BEFORE clearLocks, then teardown + abort + release. */
	private detachActive(): void {
		if (!this.active) return;
		const t = this.deps.truth();
		// Kill switch: transfer strategy ownership to the human (subst preserved) BEFORE releasing the
		// locks — a strategy fold outside the protected tail survives detach as a human fold.
		if (t) {
			t.apply([{ kind: "freeze" }], "you");
			// P1-5: inherit the conductor-enforced tail as the human's `protectTokens` BEFORE the lock
			// releases. Without this, a `tail-size` conductor's (often zero) tail snaps back to the
			// human's larger dial and the next housekeep prunes the freeze-converted whole-session group
			// and heals the frozen folds — destroying exactly the work `freeze` promised to preserve.
			t.clearLocks({ inheritTail: true });
		}
		if (this.inProcessConductor) {
			try {
				this.inProcessConductor.detach();
			} catch {
				/* a throwing detach must not strand the host */
			}
			this.inProcessConductor = null;
		}
		this.listeners.clear();
		if (this.spawnChild) {
			const child = this.spawnChild;
			this.spawnChild = null; // null BEFORE kill so the onExit guard treats this as expected
			this.killChild(child);
		}
		this.conductorSocket = null;
		this.pendingToken = null;
		if (this.pendingAttachTimer) {
			clearTimeout(this.pendingAttachTimer);
			this.pendingAttachTimer = null;
		}
		for (const c of this.completions) {
			try {
				c.abort();
			} catch {
				/* ignore */
			}
		}
		this.completions.clear();
		this.completionsByReqId.clear();
		this.releaseHold(); // unblock any pending wire-departing hold so a stalled hook proceeds
		// Reset the last-hold gauge (keep the cumulative `holdTimeouts` counter): with no conductor
		// attached no hold ever fires, so a stale `lastHoldMs` would keep MapHeader subtracting a
		// phantom hold from the hook time (netHookMs = hookMs - holdMs) and mask a genuinely slow hook.
		this.lastHoldMsValue = 0;
		this.cachedStatusMsg = null;
		this.active = null;
		this.mode = null;
	}

	/** Detach because something went wrong (runner never dialed in, or exited): surface WHY first. */
	private autoDetach(reason: string): void {
		if (!this.active) return;
		this.setAndBroadcastStatus(reason);
		this.detachActive();
		this.deps.broadcast({ type: "conductorState", active: null });
	}

	/** SIGTERM the child, then SIGKILL after a grace if it hasn't exited. */
	private killChild(child: SpawnedRunner): void {
		let exited = false;
		try {
			child.onExit(() => {
				exited = true;
			});
		} catch {
			/* ignore */
		}
		try {
			child.kill(); // extension maps the first kill → SIGTERM
		} catch {
			/* ignore */
		}
		const timer = setTimeout(() => {
			if (!exited) {
				try {
					child.kill(); // extension maps a second kill → SIGKILL
				} catch {
					/* ignore */
				}
			}
		}, GRACE_MS);
		(timer as { unref?: () => void }).unref?.();
	}

	/** SIGTERM→grace→SIGKILL any child and abort in-flight completions (session_shutdown). */
	shutdown(): void {
		this.detachActive();
	}

	// ── host-lifecycle moments ───────────────────────────────────────────────────
	/** Every Truth event: fan out to an in-process conductor as HostEvents. Remote replicas derive
	 *  these themselves from the WireEvent stream the extension already broadcasts, so this is a
	 *  no-op for a spawn conductor. */
	dispatchTruthEvent(e: TruthEvent): void {
		if (this.mode !== "in-process") return;
		const t = this.deps.truth();
		if (!t) return;
		for (const he of hostEventsFromTruthEvent(t, e)) this.fire(he);
	}

	/** A structural rebuild replaced the Truth (divergence) — resync an in-process conductor. A
	 *  remote replica gets the forced resnapshot broadcast the extension already sends. */
	dispatchResync(): void {
		if (this.mode !== "in-process") return;
		this.fire({ type: "resync", rev: this.deps.truth()?.rev ?? 0 });
	}

	/** A turn settled — the canonical re-plan trigger. In-process fires; remote is notified. */
	fireTurnCommitted(turn: number, rev: number): void {
		if (!this.active) return;
		if (this.mode === "in-process") this.fire({ type: "turn-committed", turn, rev });
		else this.deps.sendToConductor({ type: "turnCommitted", turn, rev });
	}

	/**
	 * Fire an initial turn-committed so a freshly attached conductor evaluates the EXISTING state at
	 * once (P1-6), instead of idling until the next real turn settles. IN-PROCESS: `select` calls this
	 * at the end of attach, so the just-subscribed conductor gets an immediate pass. REMOTE: the
	 * extension calls this AFTER it has dispatched the conductor's first `snapshot`, so the spawned
	 * SDK has hydrated its replica and run `conductor.attach` — its listener is live, so the
	 * `turnCommitted` message it then receives actually drives a pass (sent before the snapshot it
	 * would be dropped by the not-yet-attached SDK). Turn/rev are the current tail's.
	 */
	fireInitialTurnCommitted(): void {
		const t = this.deps.truth();
		if (!this.active || !t) return;
		const last = t.blocks[t.blocks.length - 1];
		this.fireTurnCommitted(last ? last.turn : 0, t.rev);
	}

	/** An agent `recall` observation. In-process fires the derived state-changed; remote already
	 *  receives the broadcast `{type:"recall"}` message. */
	dispatchRecall(ids: string[], by: Actor): void {
		if (this.mode !== "in-process" || !ids.length) return;
		this.fire(recallHostEvent(ids, by, this.deps.truth()?.rev ?? 0));
	}

	/**
	 * Fire `wire-departing` and hold the departing wire for a last-moment proposal (v14 semantics):
	 *  - IN-PROCESS: dispatch synchronously to the listener(s). If a handler returns a promise, race
	 *    it against `holdWireUpToMs`; a purely synchronous handler resolves immediately (same tick).
	 *    Release is tied to the handler's returned promise SETTLING.
	 *  - REMOTE: send `wireDeparting` (carrying a unique `holdId`), then resolve when the conductor
	 *    sends `holdRelease { holdId }` — which the SDK emits the moment its handler settles, exactly
	 *    mirroring the in-process semantics — raced against the timeout. A `propose` no longer releases
	 *    the hold (P1-2): a concurrent background-tick propose used to race the hold and release it
	 *    before the handler's last-moment fold landed.
	 *
	 * The `holdId` doubles as the generation guard: a stale/unknown `holdRelease` (or a timed-out
	 * hold's late release) never resolves a later hold. `lastHoldMs` is recorded each call; a timeout
	 * increments `holdTimeouts`.
	 */
	async fireWireDepartingAndAwaitHold(): Promise<void> {
		const t = this.deps.truth();
		if (!t || !this.active) return;
		const holdMs = this.active.holdWireUpToMs || 0;
		const start = this.deps.now();
		const holdId = ++this.holdSeq;
		const { event } = wireDepartingEvent(t);
		if (this.mode === "in-process") {
			// `holdId` rides the event for symmetry with the remote seam; the hold resolves purely on
			// the handler's returned promise settling (below), not on any id correlation here.
			const rets = this.dispatchToListeners({ ...event, holdId });
			const promises = rets.filter(isThenable);
			if (promises.length && holdMs > 0) {
				const timer = timeoutMarker(holdMs);
				const outcome = await Promise.race([Promise.allSettled(promises).then(() => "settled" as const), timer.promise]);
				timer.cancel();
				if (outcome === "timeout") this.holdTimeoutsValue++;
			}
		} else if (this.mode === "spawn") {
			this.deps.sendToConductor({
				type: "wireDeparting",
				rev: event.rev,
				liveTokens: event.liveTokens,
				budget: event.budget,
				freshIds: event.freshIds.slice(),
				holdMs,
				holdId,
			});
			if (holdMs > 0 && this.conductorSocket) await this.awaitRemoteHold(holdId, holdMs);
		}
		this.lastHoldMsValue = this.deps.now() - start;
	}

	private awaitRemoteHold(holdId: number, holdMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (this.holdWaiter && this.holdWaiter.holdId === holdId) {
					this.holdWaiter = null;
					this.holdTimeoutsValue++;
					resolve();
				}
			}, holdMs);
			(timer as { unref?: () => void }).unref?.();
			this.holdWaiter = { holdId, resolve, timer };
		});
	}

	/** Release the current wire-departing hold ONLY if `holdId` matches it (the `holdRelease` path). A
	 *  stale/unknown id — including a release arriving after this hold already timed out — is ignored. */
	private releaseHoldById(holdId: number): void {
		const w = this.holdWaiter;
		if (!w || w.holdId !== holdId) return;
		this.holdWaiter = null;
		clearTimeout(w.timer);
		w.resolve();
	}

	/** Unconditionally release any pending wire-departing hold (detach path — unblock a stalled hook). */
	private releaseHold(): void {
		const w = this.holdWaiter;
		if (!w) return;
		this.holdWaiter = null;
		clearTimeout(w.timer);
		w.resolve();
	}

	// ── internals ─────────────────────────────────────────────────────────────────
	private applyPropose(baseRev: number | undefined, ops: Op[]): TxnResult {
		// Guard host-only ops (`freeze`) at the conductor wire entry, same as the GUI `ops` command:
		// a conductor propose must not be able to reach the ungated detach kill switch (it would seize
		// its OWN strategy folds as human folds). A smuggled freeze is stripped and reported back as a
		// `locked` clamp in the proposeResult's per-op results.
		return applyGuardingHostOnly(ops, (allowed) => {
			const t = this.deps.truth();
			if (!t) return { rev: 0, results: allowed.map((op) => ({ op, applied: false, clamped: "unknown-id" as const })) };
			return t.apply(allowed, "auto", baseRev);
		});
	}

	private handleCompleteRequest(from: unknown, req: CompleteRequestMessage): void {
		const controller = new AbortController();
		this.completions.add(controller);
		this.completionsByReqId.set(req.reqId, controller); // so a `cancelComplete { reqId }` (S7) can abort it
		const cr: CompletionRequest = { prompt: req.prompt, system: req.system, maxOutputTokens: req.maxOutputTokens, model: req.model, signal: controller.signal };
		// Reply to the ORIGINATING socket, not the currently-active one: a completion resolving after
		// an A→B conductor swap must route back to the A that asked (a no-op if A is gone), never leak
		// to whoever attached in the meantime.
		void this.deps
			.runCompletion(cr, controller.signal)
			.then(
				(res) =>
					this.deps.sendToSocket(from, {
						type: "completeResult",
						reqId: req.reqId,
						ok: true,
						text: res.text,
						model: res.model,
						inputTokens: res.inputTokens,
						outputTokens: res.outputTokens,
					}),
				(err) => this.deps.sendToSocket(from, { type: "completeResult", reqId: req.reqId, ok: false, error: err instanceof Error ? err.message : String(err) }),
			)
			.finally(() => {
				this.completions.delete(controller);
				this.completionsByReqId.delete(req.reqId);
			});
	}

	private setAndBroadcastStatus(text: string | null, metrics?: Record<string, number | string | boolean>): void {
		this.cachedStatusMsg = { type: "conductorStatus", text, metrics };
		this.deps.broadcast(this.cachedStatusMsg);
	}

	private spawnEnvRecord(token: string): Record<string, string> {
		const e = this.deps.spawnEnv();
		return {
			ACCORDION_PORT: String(e.port),
			ACCORDION_TOKEN: token,
			ACCORDION_SESSION_KEY: e.sessionKey,
			ACCORDION_HOME: e.home,
		};
	}

	private dispatchToListeners(e: HostEvent): Array<void | Promise<void>> {
		const rets: Array<void | Promise<void>> = [];
		for (const fn of this.listeners) {
			try {
				rets.push(fn(e));
			} catch {
				/* a throwing listener must not break the hold */
			}
		}
		return rets;
	}
	private fire(e: HostEvent): void {
		for (const fn of this.listeners) {
			try {
				void fn(e);
			} catch {
				/* ignore */
			}
		}
	}
}

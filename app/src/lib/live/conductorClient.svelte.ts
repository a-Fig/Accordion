/*
 * conductorClient.svelte.ts — Accordion's side of the conductor wire (ADR 0007).
 *
 * Turns an out-of-process conductor (a WebSocket endpoint) into something the engine can
 * `attach()`: a `RemoteRunner` that implements the in-process `Conductor` interface. The
 * trick is bridging async ↔ sync. The store calls `conduct()` synchronously on every
 * context change and must never block on a model call; the remote answers whenever it
 * likes. So:
 *
 *   - `conduct(snapshot)` PUSHES the snapshot to the remote (fire-and-forget) and returns
 *     the conductor's LAST known desired commands (or `null` = hold) — it never waits.
 *   - When the remote later sends `conductor/commands`, the runner caches them and pokes
 *     the store (`refold()`), which re-enters `conduct()`, reads the fresh cache, and the
 *     host applies it. ClampReports flow back as `host/commandResult`.
 *
 * "GUI drives, conductor is thin" in reverse: here the conductor drives, and this client
 * is the thin adapter that keeps the engine's safety floor (it never bypasses
 * `applyCommands`, which clamps every command to provider-validity).
 */
import type { AccordionStore } from "../engine/store.svelte";
import { inProcessConductor } from "$conductors";
import { digest } from "../engine/digest";
import { estTokens, firstLine } from "../engine/tokens";
import type { ConductorEntry } from "./registry";
import {
	CONDUCTOR_PROTOCOL_VERSION,
	LOCK_NAMES,
	isConductorMessage,
	type Conductor,
	type ConductorHost,
	type ConductorView,
	type Command,
	type ContentMode,
	type ConductorMessage,
	type HostHelloMessage,
	type ContextUpdateMessage,
	type LockName,
} from "$conductors/contract";

/** The well-known id of the in-process default conductor. */
export const BUILTIN_ID = "builtin";
/** The well-known id meaning "no conductor" — raw, un-managed context. */
export const NONE_ID = "none";

/** Connection status of the active remote conductor, surfaced to the UI. */
export const conductorLink = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string }>({
	status: "idle",
	detail: "",
});

/**
 * Display-only telemetry from the active remote conductor (`conductor/status`, ADR 0007). A
 * conductor may push a one-line `text` (+ optional structured `metrics`) describing what it is
 * calculating; the UI renders it near the switcher and does NOTHING else with it — it never
 * folds or steers on this. Empty `text` ⇒ no readout (the in-process built-in never emits one,
 * and we clear this whenever the remote drops or is swapped out). One active remote at a time,
 * mirroring `conductorLink`. */
export const conductorStatus = $state<{ text: string; metrics: Record<string, number | string | boolean> }>({
	text: "",
	metrics: {},
});

/** Clear the status readout — on disconnect, swap, or detach, so no stale line lingers. */
function clearConductorStatus(): void {
	conductorStatus.text = "";
	conductorStatus.metrics = {};
}

/** Bumped when a remote conductor that HAD connected drops unexpectedly. The attach effect
 *  in +page.svelte reads this, so a same-list socket drop (which changes no discovered-list
 *  reference) still re-fires the effect → attachConductor tears down the dead runner and
 *  re-dials if the entry is still advertised (else falls back to the built-in). Gated on
 *  `greeted` so a conductor that never connected can't thrash-retry; exponential backoff is
 *  still future work. */
export const conductorRetry = $state({ tick: 0 });

/**
 * A conductor that lives in another process, reached over a WebSocket. Implements
 * `Conductor` so the engine can attach it like any other strategy; all the async lives
 * here, behind a synchronous `conduct()`.
 */
export class RemoteRunner implements Conductor {
	readonly id: string;
	readonly label: string;
	/** Involvement locks declared by the remote conductor in its `conductor/hello`. Undefined
	 *  until the hello arrives; set to a frozen array (possibly empty) once greeted.
	 *  Undefined / empty ⇒ collaborative. Non-empty ⇒ exclusive. */
	locks: readonly LockName[] | undefined = undefined;

	private ws: WebSocket | null = null;
	private manualClose = false;
	/**
	 * The host-capabilities handle injected by the store via `attach(host)` on attach.
	 * Null until attach is called; cleared in detach. A WS conductor uses this to serve
	 * "complete" capability requests from the remote process — the wire is just a transport:
	 * the remote conductor calls `cap/request { capability:"complete" }`, RemoteRunner
	 * proxies the call to the same `host.complete()` that an in-process conductor uses.
	 */
	private host: ConductorHost | null = null;
	/** True after an UNEXPECTED socket drop (not a manual close). A dead runner can never
	 * re-dial, so `attachConductor` must not treat it as "already correctly attached". */
	private _dead = false;
	get isDead(): boolean { return this._dead; }
	/** The conductor's last desired command set; `null` until it has ever spoken (⇒ hold/raw). */
	private desired: Command[] | null = null;
	private wants: ContentMode = "full";
	private rev = 0;
	private lastRev = 0;
	/** Set when WE triggered the refold (applying just-received commands) so we don't echo a redundant context/update. */
	private suppressUpdate = false;
	/** True once `conductor/hello` has arrived — we hold the first context push until then so
	 * a `wants:"shape"/"onDemand"` conductor never receives one full-text frame it didn't ask for. */
	private greeted = false;

	constructor(
		private entry: ConductorEntry,
		private store: AccordionStore,
	) {
		this.id = entry.id;
		this.label = entry.label;
	}

	// ---- Conductor interface ----------------------------------------------
	conduct(view: ConductorView): Command[] | null {
		if (this.suppressUpdate) this.suppressUpdate = false;
		else if (this.greeted) this.pushContext(view); // hold the first push until wants is known
		return this.desired;
	}

	/**
	 * OPTIONAL Conductor lifecycle — called once by the store on attach, before the first
	 * `conduct()`. Stashes the host reference so `serveCapability` can proxy "complete"
	 * requests from the remote process through the same host the store provides to every
	 * in-process conductor. The WS is merely a transport for the same service.
	 */
	attach(host: ConductorHost): void {
		this.host = host;
	}

	/**
	 * OPTIONAL Conductor lifecycle — called by the store on detach / swap. Clears the
	 * host reference so any in-flight "complete" cap/request that arrives after the remote
	 * has been detached gets a clean "completion unavailable" error rather than trying to
	 * call a host that is no longer ours.
	 *
	 * Note: we do NOT close the WebSocket here — `close()` is the explicit lifecycle call
	 * (invoked by `attachConductor` before attaching a new one). `detach()` is a STORE
	 * signal only; the socket teardown is the manager's responsibility.
	 */
	detach(): void {
		this.host = null;
	}

	// ---- lifecycle --------------------------------------------------------
	connect(): void {
		if (typeof WebSocket === "undefined") return;
		this.manualClose = false;
		conductorLink.status = "connecting";
		conductorLink.detail = this.entry.url;
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.entry.url);
		} catch (e) {
			conductorLink.status = "error";
			conductorLink.detail = e instanceof Error ? e.message : String(e);
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			if (this.ws !== ws) return;
			const hello: HostHelloMessage = {
				type: "host/hello",
				conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
				session: { title: this.store.meta.title, model: this.store.meta.model, cwd: this.store.meta.cwd },
				budget: this.store.budget,
				contextWindow: this.store.contextWindow,
			};
			this.send(hello);
			conductorLink.status = "connected";
			conductorLink.detail = this.entry.label;
			// Do NOT push context yet — wait for conductor/hello to learn `wants`, then push.
		};
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return;
			let msg: unknown;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				return;
			}
			this.handle(msg);
		};
		ws.onerror = () => {
			if (this.ws !== ws) return;
			conductorLink.status = "error";
			conductorLink.detail = `cannot reach ${this.entry.url}`;
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			if (!this.manualClose) {
				// Unexpected drop: clear stale commands so conduct() returns [] (raw) rather
				// than perpetuating the last known desired state against a dead conductor.
				this.desired = [];
				this._dead = true;
				clearConductorStatus(); // the telemetry line is stale now → hide it

				// Immediately re-run the conductor pass so the store renders raw NOW rather than
				// waiting for the next unrelated refold. conduct() reads this.desired (now [])
				// and returns [], which clears all conductor folds in the same tick.
				this.store.refold();
				if (conductorLink.status !== "error") {
					conductorLink.status = "error";
					conductorLink.detail = `disconnected from ${this.entry.label}`;
				}
				// A runner that had actually connected (greeted) just suffered a transient loss — schedule
				// exactly one automatic re-dial by bumping the reactive retry tick the attach effect tracks.
				// If it never greeted (conductor down / unreachable), do NOT bump, so a re-dial that fails
				// before connecting can't loop. The re-dialed runner is a fresh instance (greeted=false), so
				// a second failure-before-connect ends the chain; a genuine reconnect resets it.
				if (this.greeted) conductorRetry.tick++;
			}
		};
	}

	close(finalStatus?: "idle" | "error", finalDetail?: string): void {
		this.manualClose = true;
		const ws = this.ws;
		this.ws = null;
		clearConductorStatus(); // swapped/detached → drop any telemetry line
		conductorLink.status = finalStatus ?? "idle";
		conductorLink.detail = finalDetail ?? "";
		try {
			ws?.close();
		} catch {
			/* already gone */
		}
	}

	// ---- inbound ----------------------------------------------------------
	private handle(msg: unknown): void {
		if (!isConductorMessage(msg)) return;
		const m: ConductorMessage = msg;
		switch (m.type) {
			case "conductor/hello":
				if (m.conductorProtocol !== CONDUCTOR_PROTOCOL_VERSION) {
					const detail = `protocol mismatch — conductor v${m.conductorProtocol}, app v${CONDUCTOR_PROTOCOL_VERSION}`;
					this.close("error", detail);
					return;
				}
				if (m.wants?.content) this.wants = m.wants.content;
				// Capture involvement locks (ADR 0011). Validate defensively: only accept
				// entries that are known LockName values (wire input may carry garbage).
				// Normalize: absent/empty → undefined (collaborative); valid entries → frozen array.
				{
					const rawLocks = Array.isArray(m.locks) ? m.locks : [];
					const validLocks = rawLocks.filter((l): l is LockName => LOCK_NAMES.includes(l as LockName));
					this.locks = validLocks.length > 0 ? Object.freeze(validLocks) : undefined;
				}
				this.greeted = true;
				// ADR 0011 consent → baseline (FIX 4): a remote conductor attaches BEFORE its
				// locks are known, so `attach()`'s locked-domain release never ran. Now that the
				// declared locks are set on THIS runner (= `store.conductor.locks`), reconcile:
				// release standing human/agent holds in the newly-known locked domains, then
				// refold. `reconcileLocks` refolds, so this also serves as the first context push
				// honouring the declared `wants`.
				this.store.reconcileLocks();
				break;
			case "conductor/commands": {
				// Bug #3: a conductor MUST complete the handshake before it can steer. Protocol-
				// version validation (and the lock declaration) live ONLY in the `conductor/hello`
				// case, so commands arriving before/without a hello would bypass that gate entirely —
				// a version-mismatched or never-greeted conductor could fold the live context. Ignore
				// any commands until greeted; a well-behaved conductor always sends hello first.
				if (!this.greeted) break;
				// Drop replies to stale snapshots. If the conductor echoed a rev that is
				// older than the latest context/update we have sent, this reply was computed
				// against a state we already superseded — applying it would rewind decisions.
				// If rev is absent, accept as before (backward-compatible with conductors that
				// do not echo rev).
				// Liveness tradeoff: a human interaction between our context/update and the
				// conductor's reply bumps this.rev, so a slow conductor's in-flight reply is
				// dropped as stale and it must recompute against the newer snapshot — intentional,
				// because applying a command set computed against an old view could rewind state.
				if (m.rev !== undefined && m.rev < this.rev) break;
				this.desired = Array.isArray(m.commands) ? m.commands : [];
				this.lastRev = m.rev ?? this.rev;
				// Apply now. We poke the store, which re-enters conduct(); suppress the
				// redundant context/update that re-entry would otherwise emit.
				this.suppressUpdate = true;
				this.store.refold();
				// Report back exactly what the host had to clamp.
				this.send({ type: "host/commandResult", rev: this.lastRev, reports: this.store.lastReports });
				break;
			}
			case "cap/request":
				this.serveCapability(m);
				break;
			case "conductor/status":
				// Display-only: stash the latest text/metrics for the UI. Deliberately does NOT
				// refold or touch any command/fold path — this channel never steers context.
				conductorStatus.text = m.text ?? "";
				conductorStatus.metrics = m.metrics ?? {};
				break;
		}
	}

	/**
	 * Answer a capability request from the remote conductor (the host owns the engine + tokenizer).
	 *
	 * Synchronous capabilities ("countTokens", "getContent", "getDigest") reply inline.
	 * The async "complete" capability is handled in its own async IIFE so it never blocks
	 * the synchronous dispatch of the other cases; the existing sync paths are unchanged.
	 *
	 * "complete" proxies through the SAME `host.complete()` that an in-process conductor uses —
	 * the WS is merely a transport for the same capability. The remote process calls
	 * `cap/request { capability:"complete", completion: { prompt, system?, maxOutputTokens? } }`
	 * and receives `cap/result { ok, value:text, model, inputTokens, outputTokens }` asynchronously.
	 */
	private serveCapability(m: Extract<ConductorMessage, { type: "cap/request" }>): void {
		// "complete" is async — handle it in a detached async path so it never blocks the
		// synchronous dispatch of the other cases below. AbortSignal is not serializable over
		// this conductor WS protocol, so a detached remote conductor may still incur an in-flight
		// model call; stale results are dropped by send()/host guards rather than applied.
		if (m.capability === "complete") {
			void (async () => {
				if (!this.host || !this.host.can("complete")) {
					this.send({ type: "cap/result", reqId: m.reqId, ok: false, error: "completion unavailable" });
					return;
				}
				const prompt = m.completion?.prompt;
				if (typeof prompt !== "string" || !prompt) {
					this.send({ type: "cap/result", reqId: m.reqId, ok: false, error: "missing completion.prompt" });
					return;
				}
				try {
					const r = await this.host.complete({
						system: m.completion?.system,
						prompt,
						maxOutputTokens: m.completion?.maxOutputTokens,
					});
					this.send({
						type: "cap/result",
						reqId: m.reqId,
						ok: true,
						value: r.text,
						model: r.model,
						inputTokens: r.inputTokens,
						outputTokens: r.outputTokens,
					});
				} catch (e) {
					this.send({
						type: "cap/result",
						reqId: m.reqId,
						ok: false,
						error: String((e as Error)?.message ?? e),
					});
				}
			})();
			return; // synchronous path exits here; the async IIFE fires independently
		}

		// Synchronous capabilities — reply inline, no await.
		const id = m.ids?.[0];
		const b = id ? this.store.get(id) : undefined;
		let value: string | number | undefined;
		let ok = true;
		let error: string | undefined;
		switch (m.capability) {
			case "countTokens":
				value = estTokens(m.text ?? "");
				break;
			case "getContent":
				if (b) value = b.text;
				else ((ok = false), (error = `no block ${id}`));
				break;
			case "getDigest":
				if (b) value = digest(b);
				else ((ok = false), (error = `no block ${id}`));
				break;
			default:
				ok = false;
				error = `unknown capability ${m.capability}`;
		}
		this.send({ type: "cap/result", reqId: m.reqId, ok, value, error });
	}

	// ---- outbound ---------------------------------------------------------
	/** Tell the conductor about a host-side event it didn't initiate (agent unfold / human override). */
	notifyEvent(event: "agentUnfold" | "humanOverride", ids: string[], detail?: string): void {
		this.send({ type: "host/event", event, ids, detail });
	}

	/**
	 * Ship the prebuilt `ConductorView` to the remote almost verbatim — the store already
	 * built the single public view, so the runner only adjusts content FIDELITY. Under
	 * `wants:"full"` each block's `text` rides along as-is; otherwise we downgrade — drop the
	 * full text and substitute a one-line `preview` — so a `shape`/`onDemand` conductor never
	 * receives text it didn't ask for.
	 */
	private pushContext(view: ConductorView): void {
		const blocks =
			this.wants === "full"
				? view.blocks
				: view.blocks.map((b) => {
						const { text: _text, ...rest } = b;
						return { ...rest, preview: firstLine(b.text ?? "", 100) };
					});
		const update: ContextUpdateMessage = {
			type: "context/update",
			rev: ++this.rev,
			budget: view.budget,
			contextWindow: view.contextWindow,
			liveTokens: view.liveTokens,
			protectedFromIndex: view.protectedFromIndex,
			protectTokens: view.protectTokens,
			blocks,
		};
		this.send(update);
	}

	private send(msg: object): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* socket gone — a later context/update will retry */
		}
	}
}

// ─── the attach manager ────────────────────────────────────────────────────────
// One remote runner at a time is attached to the active session's store. The manager
// builds the right Conductor for the selected id and swaps it in, tearing down any prior
// remote connection so a switch never leaves two sockets open.

let activeRemote: RemoteRunner | null = null;
// What we last attached, so a re-invocation that asks for the SAME thing is a no-op (a
// discovery poll refreshing the list must never tear down and reconnect a healthy remote).
let lastStore: AccordionStore | null = null;
let lastId: string | null = null;
// True when the last attach DETACHED to raw as a fallback for a selected remote that wasn't
// discovered yet (main #35: we run raw, not the built-in, so the user's chosen strategy is the
// only thing that ever folds). Without this, the guard below never matches that case, so every
// discovery poll re-detaches → refold → unbounded churn that can pin the reactive scheduler
// (effect_update_depth_exceeded). Cleared whenever we attach/detach for a genuinely new reason.
let lastFallback = false;

/** The remote runner currently attached, if any (so callers can route host events to it). */
export function activeRemoteRunner(): RemoteRunner | null {
	return activeRemote;
}

/**
 * Attach the conductor identified by `id` to `store`. `null`/`"none"` ⇒ detach (the ADR 0011
 * kill switch: freezes the current folded view as human-owned, then unlocks all controls);
 * any id in the in-process registry (`IN_PROCESS_CONDUCTORS` — `"builtin"` and any future
 * sibling) ⇒ a fresh in-process instance; anything else ⇒ a remote runner dialed at the
 * matching discovered/configured `ConductorEntry` (running RAW via `attach(null)` if the entry
 * isn't available *yet*, so nothing folds with the wrong strategy). Safe to call from an effect
 * that tracks the available list: it is IDEMPOTENT — if we are already correctly attached to
 * `id` on `store` it returns untouched (no reconnect on list churn / heartbeat refresh), and
 * a vanished-but-still-connected remote is left alone; only a genuine change swaps.
 */
export function attachConductor(store: AccordionStore, id: string | null, available: ConductorEntry[]): void {
	const norm = id ?? NONE_ID;
	const inProc = norm === NONE_ID ? null : inProcessConductor(norm);
	const isRemoteId = norm !== NONE_ID && !inProc;
	// Already correctly attached? For a remote that means the live runner's id matches AND the
	// runner is still alive (not dead from an unexpected drop); for in-process/none, just the
	// id+store. (A remote id that fell back to raw last time has activeRemote === null, so this
	// is false → we retry now that it may have appeared. A dead runner is also false → we tear it
	// down and re-dial so the conductor process can reconnect after a socket drop.)
	// Is the selected remote actually discoverable right now? (Only meaningful for a remote id.)
	const entry = isRemoteId ? available.find((e) => e.id === norm) : undefined;
	const alreadyCorrect =
		store === lastStore &&
		norm === lastId &&
		(isRemoteId
			? // a live runner for this id, OR a STABLE detached-to-raw state while the remote is still absent
			  (activeRemote?.id === norm && !activeRemote.isDead) || (lastFallback && !entry)
			: true);
	if (alreadyCorrect) return;

	if (activeRemote) {
		activeRemote.close();
		activeRemote = null;
	}
	store.onHumanOverride = null;
	lastStore = store;
	lastId = norm;
	lastFallback = false;

	if (norm === NONE_ID) {
		store.detach();
		return;
	}
	if (inProc) {
		store.attach(inProc.create()); // fresh in-process instance (builtin or a sibling)
		return;
	}
	if (!entry) {
		// attach(null), NOT detach(): detach() now FREEZES the current view (ADR 0011 kill
		// switch). A transient waiting-for-remote state must go raw so the remote authors from a
		// clean baseline when it connects, rather than inheriting frozen human folds.
		store.attach(null); // selected remote not available — run raw until it connects (main #35)
		lastFallback = true; // fell back to raw; don't re-refold every poll until the remote appears
		return;
	}
	const runner = new RemoteRunner(entry, store);
	activeRemote = runner;
	// Tell the remote when the human overrides by hand (ADR 0007 host/event: humanOverride).
	store.onHumanOverride = (ids, action) => runner.notifyEvent("humanOverride", ids, action);
	store.attach(runner); // conduct() returns null until commands arrive ⇒ raw meanwhile
	runner.connect();
}

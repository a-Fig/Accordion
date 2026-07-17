/*
 * remote.ts — the out-of-process conductor SDK (Phase C). Runs a `Conductor` (`./contract`) as a
 * WebSocket CLIENT against the v13 wire (`../protocol`), presenting it with a `ConductorHost` built
 * from a local REPLICA `Truth` — never a second, hand-rolled derivation. Every read (`get` /
 * `blocks` / `textOf` / `stats` / `groups` / `countTokens` / `digestOf`) goes through the exact
 * same `hostAdapter.ts` helpers `TestHost` uses, and every mutation of the replica goes through
 * `../replica`'s `hydrateSnapshot` / `applyWireEvent` — REUSED VERBATIM, never reimplemented, so a
 * conductor golden-tested against `TestHost` sees an identical read surface here.
 *
 * `conductors/thermocline/runner.mjs` is the intended consumer: it spawns as its own Node process
 * (the extension owns the spawn), reads `ACCORDION_PORT`/`ACCORDION_TOKEN` from its environment,
 * and calls `runRemoteConductor(new ThermoclineConductor(...), { port, token, signal })`.
 *
 * ── Dependency-free stance ───────────────────────────────────────────────────────────────────
 * `core/` is framework-free and dependency-free by longstanding convention (see protocol.ts /
 * contract.ts / hostAdapter.ts's own doc comments) — it is imported by BOTH the extension (a real
 * Node process with `ws` as a runtime dependency) and the app (a browser bundle, where `ws` cannot
 * resolve at all). Importing the `ws` package directly here would tie this shared layer to a
 * Node-only runtime dependency the browser side can never satisfy. Node 22 (the runtime this SDK
 * actually runs under, per `conductors/thermocline/runner.mjs`) ships a spec-compliant global
 * `WebSocket` client, so the default `wsFactory` uses that; a caller embedding this SDK elsewhere
 * (or a test) may inject any constructor-shaped factory that produces the same minimal surface
 * (`onopen`/`onmessage`/`onerror`/`onclose`, `send`, `close`, `readyState`) — exactly the subset
 * `app/src/lib/live/liveClient.svelte.ts` already relies on for the GUI's own WS client, so the two
 * peers' client code stays recognizably parallel.
 *
 * ── Dial convention ──────────────────────────────────────────────────────────────────────────
 * `ws://{host}:{port}/?role=conductor&token={token}` — the token rides the QUERY STRING, exactly
 * matching `liveClient.svelte.ts`'s own `tokenQs` convention (never an `Authorization` header;
 * the token-gated WS upgrade reads it off the URL for every role, GUI or conductor).
 *
 * ── PROTOCOL/CONTRACT GAP (reported, not fixed — contract.ts is frozen; see the task report) ───
 * `ConductorHost.propose(txn): TxnResult` (`./contract`) is declared SYNCHRONOUS. Every shipped
 * conductor calls it that way — `conductors/thermocline/thermocline.ts:604,662`,
 * `core/conductors/doorman/doorman.ts:161`, and `./view.ts:213` all do
 * `const res = this.host.propose({ baseRev, ops }); ... for (const r of res.results)` with NO
 * `await`. An out-of-process host has no synchronous escape hatch: `propose` must cross the wire
 * (send `propose`, await the matching `proposeResult`) — there is no way to block Node's event
 * loop for a network round trip and hand back a real `TxnResult` in the same tick. This module
 * implements the ONLY honest option — an async round trip that returns the host's actual
 * `proposeResult` verbatim — which means `RemoteConductorHost.propose` returns a `Promise`, not a
 * `TxnResult`. See `RemoteConductorHost` below: it is NOT literally a `ConductorHost` at the type
 * level, and is cast at the single boundary where `conductor.attach()` needs one. Running an
 * existing synchronous-propose conductor against this SDK as built WILL throw where it reads
 * `res.results` (`res` is a `Promise`, which has no such property). This needs the coordinator's
 * sign-off: either `ConductorHost.propose` becomes `Promise<TxnResult>` (and every existing call
 * site gains an `await`), or the SDK needs a different design (e.g. a synchronous LOCAL dry-run
 * against a cloned replica `Truth`, firing the real `propose` over the wire independently and
 * reconciling via the ordinary echoed `event` — deliberately NOT implemented here without
 * sign-off, since it would silently paper over the exact mismatch this comment exists to surface).
 */
import type { Truth } from "../truth";
import { hydrateSnapshot, applyWireEvent } from "../replica";
import { viewBlockOf, hostEventsFromTruthEvent, recallHostEvent } from "./hostAdapter";
import { estTokens } from "../tokens";
import { digest } from "../digest";
import type { SessionMeta } from "../types";
import type { Op, TxnResult } from "../ops";
import type { Conductor, ConductorHost, HostEvent, ViewBlock, GroupInfo, CompletionRequest, CompletionResult } from "./contract";
import {
	PROTOCOL_VERSION,
	isServerMessage,
	type ServerMessage,
	type ClientMessage,
	type SnapshotState,
} from "../protocol";

// ── minimal WebSocket surface (browser-shaped; matches liveClient.svelte.ts's usage) ───────────

/** The subset of the standard `WebSocket` API this module needs. Both Node's built-in global
 *  `WebSocket` and the `ws` package's client satisfy this shape. */
export interface WSLike {
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

/** Builds a `WSLike` client for a `ws://` URL. Defaults to the global `WebSocket` (Node 22+). */
export type WSFactory = (url: string) => WSLike;

const WS_OPEN = 1;

function defaultWsFactory(url: string): WSLike {
	const Ctor = (globalThis as { WebSocket?: new (u: string) => WSLike }).WebSocket;
	if (!Ctor) {
		throw new Error(
			"remote conductor SDK: no global WebSocket available in this runtime — pass opts.wsFactory (Node 22+ ships one built in)",
		);
	}
	return new Ctor(url);
}

export interface RemoteConductorOptions {
	/** The loopback port the extension advertises for this session. */
	port: number;
	/** Bearer token for the token-gated WS upgrade — sent in the query string, never a header. */
	token: string;
	/** Optional teardown signal — aborting it closes the socket and detaches the conductor. */
	signal?: AbortSignal;
	/** Host to dial. Default `127.0.0.1` — the live link only ever binds loopback. */
	host?: string;
	/** WebSocket client constructor. Default: `globalThis.WebSocket` (see the module doc above). */
	wsFactory?: WSFactory;
}

/**
 * See the module-level "PROTOCOL/CONTRACT GAP" doc above: structurally identical to
 * `ConductorHost` except `propose`, which an out-of-process host cannot make synchronous.
 */
export interface RemoteConductorHost extends Omit<ConductorHost, "propose"> {
	propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult>;
}

/**
 * Run `conductor` as a resident, out-of-process strategy against the pi extension's v13 wire.
 * Resolves once the socket has closed (cleanly, via `opts.signal`, or via SIGINT/SIGTERM) and
 * `conductor.detach()` has run; rejects only on a loud, unrecoverable startup failure (protocol or
 * role mismatch on `hello`) — mirroring `app/src/lib/live/liveClient.svelte.ts`'s own mismatch
 * handling, which likewise refuses to pair silently.
 */
export function runRemoteConductor(conductor: Conductor, opts: RemoteConductorOptions): Promise<void> {
	const host = opts.host ?? "127.0.0.1";
	const wsFactory = opts.wsFactory ?? defaultWsFactory;
	const url = `ws://${host}:${opts.port}/?role=conductor&token=${encodeURIComponent(opts.token)}`;

	return new Promise<void>((resolvePromise, rejectPromise) => {
		let settled = false;
		let attached = false;
		let helloOk = false;
		let sawFirstSnapshot = false;
		let awaitingResnapshot = false;
		let proposeSeq = 0;
		let reqId = 0;
		let replica: Truth | null = null;
		let meta: SessionMeta = { format: "pi", title: "", cwd: "", model: "" };
		const listeners = new Set<(e: HostEvent) => void | Promise<void>>();
		const pendingProposes = new Map<number, { ops: Op[]; resolve: (r: TxnResult) => void }>();
		const pendingCompletes = new Map<number, { resolve: (r: CompletionResult) => void; reject: (e: unknown) => void }>();
		// The hold-release flag (see the `wireDeparting` case below): reset immediately before
		// dispatching a wire-departing HostEvent, flipped true the moment `propose` is CALLED
		// (invocation, not resolution) at any point up to the handler settling.
		let proposedSinceDispatch = false;

		let ws: WSLike;
		try {
			ws = wsFactory(url);
		} catch (e) {
			rejectPromise(e instanceof Error ? e : new Error(String(e)));
			return;
		}

		function send(msg: ClientMessage): void {
			if (ws.readyState !== WS_OPEN) return;
			try {
				ws.send(JSON.stringify(msg));
			} catch {
				/* socket gone — the pending map drains on close */
			}
		}

		function requestResnapshot(): void {
			awaitingResnapshot = true;
			send({ type: "resnapshot" });
		}

		/** Fire a HostEvent to every subscribed listener; a listener may return a promise (awaited by
		 *  callers that need to know when it settles, e.g. the wire-departing hold-release path). A
		 *  throwing/rejecting listener must never crash the wire pump. */
		async function dispatch(e: HostEvent): Promise<void> {
			const pending: Promise<void>[] = [];
			for (const fn of listeners) {
				try {
					const r = fn(e);
					if (r && typeof (r as Promise<void>).then === "function") pending.push(r as Promise<void>);
				} catch {
					/* a listener must not crash the pump */
				}
			}
			if (pending.length) await Promise.allSettled(pending);
		}

		/** Install a freshly hydrated replica and subscribe its TruthEvents → HostEvents, exactly the
		 *  derivation `TestHost` uses (`hostAdapter.ts`) — never a second hand-rolled copy. */
		function installReplica(t: Truth): void {
			replica = t;
			t.onEvent((e) => {
				for (const he of hostEventsFromTruthEvent(t, e)) void dispatch(he);
			});
		}

		function sendPropose(baseRev: number, ops: Op[]): Promise<TxnResult> {
			proposedSinceDispatch = true;
			return new Promise<TxnResult>((resolve) => {
				const seq = ++proposeSeq;
				pendingProposes.set(seq, { ops, resolve });
				send({ type: "propose", seq, baseRev, ops });
			});
		}

		function sendCompleteRequest(req: CompletionRequest): Promise<CompletionResult> {
			return new Promise<CompletionResult>((resolve, reject) => {
				const id = ++reqId;
				pendingCompletes.set(id, { resolve, reject });
				send({
					type: "completeRequest",
					reqId: id,
					system: req.system,
					prompt: req.prompt,
					maxOutputTokens: req.maxOutputTokens,
					model: req.model && req.model !== "current" ? req.model : undefined,
				});
			});
		}

		function buildHost(): RemoteConductorHost {
			return {
				on(fn) {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				get(id): ViewBlock | undefined {
					const b = replica!.get(id);
					return b ? viewBlockOf(replica!, b) : undefined;
				},
				blocks(): readonly ViewBlock[] {
					return replica!.blocks.map((b) => viewBlockOf(replica!, b));
				},
				groups(): readonly GroupInfo[] {
					return replica!.groups.map((g) => ({ id: g.id, memberIds: g.memberIds.slice(), folded: g.folded, by: g.by ?? null, summary: g.digest }));
				},
				textOf(id): string | null {
					return replica!.get(id)?.text ?? null;
				},
				stats() {
					return replica!.stats();
				},
				countTokens(text: string): number {
					return estTokens(text);
				},
				digestOf(id): string | null {
					const b = replica!.get(id);
					return b ? digest(b) : null;
				},
				complete(req: CompletionRequest): Promise<CompletionResult> {
					return sendCompleteRequest(req);
				},
				setStatus(text, metrics) {
					send({ type: "setConductorStatus", text, metrics });
				},
				propose(txn) {
					return sendPropose(txn.baseRev, txn.ops);
				},
			};
		}

		function drainPending(): void {
			for (const [, p] of pendingProposes) {
				p.resolve({ rev: replica ? replica.rev : 0, results: p.ops.map((op) => ({ op, applied: false, clamped: "stale" as const })) });
			}
			pendingProposes.clear();
			for (const [, p] of pendingCompletes) {
				p.reject(new Error("remote conductor: connection closed before completion resolved"));
			}
			pendingCompletes.clear();
		}

		function finish(err?: unknown): void {
			if (settled) return;
			settled = true;
			try {
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
			} catch {
				/* no process (non-Node host) — nothing to remove */
			}
			if (opts.signal) {
				try {
					opts.signal.removeEventListener("abort", onAbort);
				} catch {
					/* ignore */
				}
			}
			drainPending();
			if (attached) {
				try {
					conductor.detach();
				} catch {
					/* teardown must not throw out of the pump */
				}
			}
			if (err) rejectPromise(err);
			else resolvePromise();
		}

		function onAbort(): void {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
		function onSignal(): void {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}

		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			process.on("SIGINT", onSignal);
			process.on("SIGTERM", onSignal);
		} catch {
			/* no process (non-Node host) — signals simply don't apply */
		}

		function handleMessage(msg: ServerMessage): void {
			switch (msg.type) {
				case "hello": {
					if (msg.protocolVersion !== PROTOCOL_VERSION || msg.role !== "conductor") {
						const detail = `remote conductor: protocol/role mismatch — expected v${PROTOCOL_VERSION} role "conductor", got v${msg.protocolVersion} role "${msg.role}"`;
						try {
							ws.close();
						} catch {
							/* ignore */
						}
						finish(new Error(detail));
						return;
					}
					helloOk = true;
					const m = msg.meta && typeof msg.meta === "object" ? msg.meta : ({} as Partial<SessionMeta>);
					meta = { format: "pi", title: m.title || "", cwd: m.cwd || "", model: m.model || "" };
					break;
				}
				case "snapshot": {
					if (!helloOk) return; // defense: a malformed/reordered peer must not skip the hello gate
					if (!msg.state || typeof msg.state !== "object") return;
					const state = msg.state as SnapshotState;
					const t = hydrateSnapshot(meta, state);
					if (!sawFirstSnapshot) {
						sawFirstSnapshot = true;
						installReplica(t);
						attached = true;
						const hostImpl = buildHost();
						// See the module-doc "PROTOCOL/CONTRACT GAP" note: `hostImpl.propose` is async,
						// which the frozen `ConductorHost` type does not express. Cast at this one boundary.
						conductor.attach(hostImpl as unknown as ConductorHost);
					} else {
						installReplica(t);
						awaitingResnapshot = false;
						void dispatch({ type: "resync", rev: t.rev });
					}
					break;
				}
				case "event": {
					if (!replica || awaitingResnapshot) return; // a fresh snapshot is in flight — drop
					const ev = msg.event;
					if (!ev || typeof ev !== "object") return;
					// A `reset` is resnapshotted rather than replayed — same rationale as
					// liveClient.svelte.ts: it sidesteps batched-transaction rev ambiguity, and it is a
					// rare, structural change. Everything else replays + gap-checks against `ev.rev`.
					if (ev.kind === "reset") {
						requestResnapshot();
						return;
					}
					applyWireEvent(replica, ev); // replays via Truth's own mutators — emits TruthEvents,
					// which `installReplica`'s subscription turns into HostEvents automatically.
					if (replica.rev !== ev.rev) requestResnapshot(); // diverged — mirror liveClient's check
					break;
				}
				case "wireDeparting": {
					if (!replica) return;
					const event: HostEvent = { type: "wire-departing", rev: msg.rev, liveTokens: msg.liveTokens, budget: msg.budget, freshIds: msg.freshIds };
					proposedSinceDispatch = false;
					void dispatch(event).then(() => {
						// HOLD RELEASE CONTRACT (pinned): if the handler never called `propose` while it was
						// running (tracked via the flag above, set the instant `propose` is INVOKED — not
						// when it resolves), send the sanctioned "nothing to fold" empty propose so the
						// host's bounded hold on the departing wire is released. A handler that calls
						// `propose` asynchronously AFTER this point (e.g. from a forgotten `.then()` or a
						// timer that fires later) does NOT retroactively cancel this — the empty release
						// still goes out the instant the handler settles with no propose seen, and the
						// late real propose that follows is just an ORDINARY subsequent propose (against
						// whatever baseRev is current then), not a hold-satisfying one. `host.propose` is a
						// generally available service, not exclusively a wire-departing-hold mechanism, so
						// that later call is still meaningful — it is simply no longer racing the hold.
						if (!proposedSinceDispatch) send({ type: "propose", seq: ++proposeSeq, baseRev: msg.rev, ops: [] });
					});
					break;
				}
				case "turnCommitted": {
					void dispatch({ type: "turn-committed", turn: msg.turn, rev: msg.rev });
					break;
				}
				case "recall": {
					if (!replica) return;
					void dispatch(recallHostEvent(msg.ids, msg.by, replica.rev));
					break;
				}
				case "proposeResult": {
					const p = pendingProposes.get(msg.seq);
					if (!p) return;
					pendingProposes.delete(msg.seq);
					p.resolve({ rev: msg.rev, results: msg.results });
					break;
				}
				case "completeResult": {
					const p = pendingCompletes.get(msg.reqId);
					if (!p) return;
					pendingCompletes.delete(msg.reqId);
					if (msg.ok) p.resolve({ text: msg.text ?? "", model: msg.model ?? "", inputTokens: msg.inputTokens, outputTokens: msg.outputTokens });
					else p.reject(new Error(msg.error ?? "remote conductor: completion failed"));
					break;
				}
				default:
					// folding / telemetry / stream / commandResult / conductorState / conductorStatus are
					// GUI-facing broadcasts with no `HostEvent` counterpart in the conductor contract —
					// nothing to do with them here.
					break;
			}
		}

		ws.onmessage = (ev) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
			} catch {
				return;
			}
			if (!isServerMessage(parsed)) return;
			handleMessage(parsed);
		};

		ws.onerror = () => {
			/* onclose (spec-guaranteed to follow) drives teardown; nothing actionable here alone */
		};

		ws.onclose = () => {
			finish();
		};
	});
}

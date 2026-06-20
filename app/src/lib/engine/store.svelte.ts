/*
 * store.svelte.ts — the accordion model.
 *
 * Owns every block's fold state and runs the automatic folder. This is the
 * single source of truth; the UI only renders it and calls its actions. Folding
 * is content substitution, never removal: a folded block still exists and still
 * carries its callId, so a tool_call/result pair is never structurally broken.
 *
 * The v0 folder is deliberately dumb: no Conductor, no relevance. It folds purely
 * to keep the live context under budget, oldest-first, lowest-value-first —
 * tool_results before thinking before reply text before tool_calls before user
 * intent. Deterministic and explainable; the smarts come later.
 */
import type { Block, Actor, SessionMeta, ParsedSession, Group } from "./types";
import { digest, digestTokens, groupDigest, groupDigestTokens, substTokens, wireFoldable } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";
import type { Conductor, ConductorView, Command, ClampReport, ClampReason, LockName, ConductorHost, CompletionRequest, CompletionResult } from "$conductors/contract";
import { hasLock } from "$conductors/contract";
import { BuiltinConductor } from "$conductors";

/** Classification of a folded group's members for accounting + the wire (ADR 0006 §4/§5). */
interface GroupShape {
	members: Block[];
	/** Members that collapse into the one summary entry (whole, pair-balanced messages). */
	collapsedMembers: Block[];
	collapsed: Set<string>;
	/** Members kept LIVE at full size — a tool-pair half whose partner is outside the group. */
	stragglers: Set<string>;
	/** First collapsed member (by order): the one block that "carries" the summary's token cost. */
	carrier: string | null;
}

// The fold-ranking (which kinds fold first) moved to `conductors/builtin/builtin.ts` — it is the
// built-in conductor's STRATEGY, not an engine constant. The store now only enforces
// provider-validity and applies whatever conductor is attached (ADR 0007).

/** Whole-block slack allowed above `protectTokens` before the next older block is left foldable. */
const PROTECT_OVERFLOW_CAP = 1.25;

/**
 * The "message key" of a block id — the id with its assistant-part suffix removed,
 * so every part of one assistant message shares a key while scalar user/result/summary
 * blocks remain their own key.
 *
 * Two id regimes share the app:
 *  • LIVE wire (`live/mapping.ts`): assistant part = `a:<anchor>:p<j>` / `m<i>:p<j>`.
 *  • LOADED transcripts (`engine/parse.ts`): assistant part = `<eid>:<j>` (bare numeric).
 *
 * Scalar durable ids like `u:<ts>` / `s:<ts>` / `r:<callId>` must NOT be stripped.
 */
function messageKey(id: string): string {
	const live = id.match(/^(.*):p(?:\d+|\?)$/);
	if (live) return live[1];
	const parsed = id.match(/^(.+):\d+$/);
	if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
	return id;
}

interface LogEntry {
	by: Actor;
	action: string;
	detail: string;
	n: number;
}

export class AccordionStore {
	meta: SessionMeta;
	blocks = $state<Block[]>([]);
	/** Token budget for the live context window. */
	budget = $state(70_000);
	/** Model's total context window, as reported by pi (null until known). */
	contextWindow = $state<number | null>(null);
	/**
	 * The protected working tail: the most recent blocks up to this token target are
	 * NEVER auto-folded, with a strict 25% whole-block overflow cap so a huge boundary
	 * block cannot silently double the protected region. When target > 0, the newest block
	 * is always protected even if it alone exceeds the cap. When target === 0, protection
	 * is fully disabled — all blocks are foldable. The automatic folder and the future
	 * Conductor only ever operate on context older than this window — the recent ~N
	 * tokens stay verbatim. Protection is absolute: manual folds are refused there too.
	 */
	protectTokens = $state(20_000);
	log = $state<LogEntry[]>([]);
	private logN = 0;
	/** Bumped on every settled change — a cheap redraw signal for canvas views. */
	version = $state(0);
	/**
	 * Multiblock folds (ADR 0006). Human-created groups, each collapsing a contiguous run
	 * of blocks into one tile/entry. An OVERLAY over `blocks` — never mutates a block, so
	 * all block-indexed math (index / protectedFromIndex / append dedup) is untouched.
	 */
	groups = $state<Group[]>([]);
	/**
	 * id → position lookup, kept in lockstep with `blocks` (built in the constructor,
	 * extended in `appendBlocks` — the only two paths that change the array's length or
	 * order). Turns `get(id)`, `appendBlocks` dedup, and `isProtected` from O(n) scans into
	 * O(1) reads; not reactive (it only changes when `blocks` does, and every reactive
	 * consumer already depends on `blocks`).
	 */
	private index = new Map<string, number>();

	/**
	 * The active context-management strategy (ADR 0007). Defaults to the built-in folder
	 * so a freshly loaded session behaves EXACTLY as before the seam existed. `attach(c)`
	 * swaps it; `detach()` (or `attach(null)`) makes the context raw — the store never
	 * invents a strategy of its own, it only runs the one attached.
	 */
	conductor = $state<Conductor | null>(new BuiltinConductor());
	/**
	 * The last command batch the active conductor asked for. When a conductor returns
	 * `null` ("hold") — e.g. a remote one still computing — the store re-applies this to
	 * the (possibly grown) context, so prior decisions persist and only new blocks arrive
	 * raw. Reset to `[]` whenever a conductor is detached.
	 */
	private lastCmds: Command[] = [];
	/** Re-entrancy latch: a command that itself re-folds (e.g. `group`) must not recurse. */
	private conducting = false;
	/**
	 * Lifecycle generation for the attached conductor. Async conductors receive a host object
	 * whose `requestRerun()` captures this epoch; if the conductor is later replaced, any stale
	 * completion is ignored instead of refolding the new strategy's state.
	 */
	private conductorEpoch = 0;
	/** Debounce token for in-process async conductor re-entry. */
	private conductorRerunQueuedFor: { conductor: Conductor; epoch: number } | null = null;
	/**
	 * ClampReports from the most recent conductor pass — what the host had to clamp to the
	 * validity floor. A remote runner reads this after triggering a pass to feed
	 * `host/commandResult` back to its conductor. Empty after a clean pass (the built-in
	 * never trips a clamp).
	 */
	lastReports = $state<ClampReport[]>([]);
	/**
	 * Optional observer the live layer sets so an attached remote conductor is told when the
	 * HUMAN overrides by hand (pin / fold / unfold / unpin / reset) — the `host/event:
	 * humanOverride` half of ADR 0007. Kept as a plain callback so the engine never imports
	 * the wire layer. Only ever fired for human ("you") actions; null ⇒ nobody is listening.
	 */
	onHumanOverride: ((ids: string[], action: string) => void) | null = null;
	/** Display-only status from the active in-process conductor. */
	conductorStatus = $state<{ text: string; metrics: Record<string, number | string | boolean> }>({
		text: "",
		metrics: {},
	});

	/**
	 * Optional completion backend injected by the live layer. The live client sets this
	 * once the WebSocket connection to the pi extension is established (and clears it on
	 * disconnect); the host exposes it to conductors via `ConductorHost.complete()`.
	 *
	 * Null whenever there is no live model link — demo sessions, read-only Claude Code
	 * transcripts, or a disconnected extension. Conductors MUST call `host.can("complete")`
	 * before depending on it; the host rejects if it is called while null.
	 */
	completer: ((req: CompletionRequest) => Promise<CompletionResult>) | null = null;

	// ---- involvement locks (ADR 0011) -------------------------------------
	/**
	 * Reactive snapshot of the active conductor's declared lock-set (ADR 0011). Empty ⇒
	 * collaborative — every path below is byte-for-byte today's behavior, which is what keeps
	 * the golden test (`conductor.builtin.test.ts`) untouched. A non-empty set ⇒ exclusive: the
	 * host gates the named human/agent controls and (under `tail-size`) hands the conductor the tail.
	 *
	 * Why a snapshot rather than reading `this.conductor?.locks` directly: an IN-PROCESS conductor
	 * carries its locks at construction, so `attach()` (which REASSIGNS `this.conductor`, a `$state`
	 * ref) makes any reactive reader re-run. A REMOTE conductor (`RemoteRunner`) attaches with
	 * `locks` still undefined; the locks arrive later in `conductor/hello` and are mutated IN PLACE
	 * on the same runner object — no `$state` reference changes, so a reader of `this.conductor`
	 * would never re-evaluate (Bug #1: the remote consent dialog / locked chrome never appeared).
	 * Mirroring the locks into this `$state` field, reassigned in BOTH `attach()` and
	 * `reconcileLocks()`, gives the UI one reactive source of truth that updates whether the locks
	 * arrive at attach (in-process) or late (remote). The engine's per-action gates read it too;
	 * because it is set synchronously before each `refold()`, enforcement stays exact.
	 */
	private activeLocks = $state<readonly LockName[]>([]);
	/**
	 * Reactive snapshot of the active conductor's declared `tailTokens` (ADR 0011). Mirrored
	 * here for the same reactivity reason as `activeLocks` (Bug #1): a remote conductor's
	 * props arrive late by in-place mutation, so reading `this.conductor.tailTokens` directly
	 * in a `$derived` would never re-track. Read this mirror, not the conductor. Always 0 for
	 * conductors that omit `tailTokens` (whole-context ownership, no protected tail).
	 */
	private activeTailTokens = $state(0);
	/** Mirror the current conductor's declared locks (and tailTokens) into the reactive
	 *  snapshots. Called from `attach()` (in-process props known now) and `reconcileLocks()`
	 *  (remote props just arrived). */
	private syncLocks(): void {
		this.activeLocks = this.conductor?.locks ?? [];
		// Clamp defensively. A buggy first-party conductor could hand NaN / Infinity / a negative.
		// Non-finite must collapse to 0 (own-the-whole-context), NOT poison the boundary: with
		// `activeTailTokens === NaN`, `protectedFromIndex` falls through to `return 0` (the WHOLE
		// context protected — the exact opposite of "own everything") and detach would inherit NaN
		// into the human's `protectTokens`. `Math.round(NaN) === NaN` and `Math.max(0, NaN) === NaN`,
		// so the finiteness guard must come first.
		const tail = this.conductor?.tailTokens;
		this.activeTailTokens = Number.isFinite(tail) ? Math.max(0, Math.round(tail as number)) : 0;
	}
	/** Does the active conductor hold `name`? PUBLIC — the UI gates affordances/tooltips on it. */
	isLocked(name: LockName): boolean {
		return hasLock(this.activeLocks, name);
	}
	/** Label of the conductor currently holding locks (for UI tooltips), or null if collaborative. */
	get lockingConductorLabel(): string | null {
		return this.activeLocks.length ? (this.conductor?.label ?? null) : null;
	}
	/**
	 * The active conductor's effective lock-set, as a REACTIVE read for the UI (ADR 0011). Prefer
	 * this over `store.conductor?.locks` in any reactive context: it tracks the `$state` snapshot,
	 * so it updates even when a remote conductor's locks arrive late and mutate the runner in place
	 * (Bug #1 — `store.conductor` keeps the same object reference, so reading `.locks` off it is
	 * NOT tracked). Empty ⇒ collaborative. `isExclusive(store.locks)` is the exclusive test.
	 */
	get locks(): readonly LockName[] {
		return this.activeLocks;
	}
	/** A HUMAN action is locked out iff it is the human's AND the conductor holds `human-steering`. */
	private humanLocked(by: Actor): boolean {
		return by === "you" && this.isLocked("human-steering");
	}

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blocks = parsed.blocks;
		this.reindex();
		this.attachConductorHost(this.conductor);
		this.refold();
	}

	/**
	 * Swap the active conductor and immediately recompute the view. `null` ⇒ raw (the
	 * programmatic "go raw"; the user-facing kill switch is `detach()`, which freezes first).
	 *
	 * ADR 0011 consent → baseline: when the incoming conductor declares a non-empty lock-set,
	 * existing HUMAN holds in a now-locked domain are released so the conductor authors from a
	 * clean baseline (the same world `conduct()` already sees). Attaching a collaborative
	 * conductor (no locks) releases nothing — byte-for-byte today's behavior.
	 */
	attach(c: Conductor | null): void {
		this.detachConductorHost(this.conductor);
		this.conductorEpoch++;
		this.conductorRerunQueuedFor = null;
		this.clearConductorStatus();
		this.conductor = c;
		// Mirror the new conductor's locks (and tailTokens) into the reactive snapshots BEFORE
		// any gate reads them (releaseLockedDomains → isLocked, the refold's protectedFromIndex
		// → isLocked("tail-size") / activeTailTokens). For an in-process conductor these are the
		// final values; a remote runner attaches with locks undefined and updates the snapshots
		// later via reconcileLocks().
		this.syncLocks();
		this.lastCmds = [];
		this.lastReports = [];
		// Release human/agent holds in the domains the NEW conductor locks. Pass `c?.locks`
		// explicitly; the `activeLocks` snapshot was just synced above so `isLocked` already agrees.
		this.releaseLockedDomains(c?.locks ?? []);
		this.attachConductorHost(c);
		this.refold();
	}
	/**
	 * The kill switch (ADR 0011 §6): freeze the current folded view in place, then go
	 * conductor-less and unlock every control. NOT reset-to-raw — dumping every block back to
	 * full could blow the budget the instant the human leaves. Each block the conductor is
	 * currently folding (folded but not already a human override) is converted into a sticky,
	 * human-owned fold (`override:"folded"`, `by:"you"`, `subst` cleared so it folds to the
	 * engine digest and stays individually reversible); any conductor-owned folded group is
	 * reassigned to the human so the subsequent raw pass keeps it. The exact on-screen view
	 * therefore persists, now human-owned, with all locks released.
	 */
	detach(): void {
		// Idempotent: detaching an already conductor-less store is a no-op. Re-running
		// freezeForDetach() on the second call would re-inherit the tail / re-stamp folds from
		// scratch; the guard makes the second detach a true no-op. cancelConsent deliberately
		// calls detach() then setActiveConductor(NONE_ID), whose attach effect detaches again —
		// this guard makes that second detach harmless.
		if (this.conductor === null) return;
		const oldConductor = this.conductor;
		this.freezeForDetach();
		this.detachConductorHost(oldConductor);
		this.conductorEpoch++;
		this.conductorRerunQueuedFor = null;
		this.clearConductorStatus();
		this.conductor = null;
		// Kill switch unlocks every control — clear the reactive lock snapshot to match the now-null
		// conductor (otherwise stale locks would keep the gates closed and the UI showing "locked").
		this.syncLocks();
		this.lastCmds = [];
		this.lastReports = [];
		this.refold();
	}

	/**
	 * Retire this store before its `session.store` slot is reassigned to a fresh
	 * `AccordionStore` (session swap, file reload, live hello / full-sync reset). Runs the
	 * attached conductor's `detach()` lifecycle hook so an in-flight `host.complete()` call is
	 * aborted — otherwise a discarded store's conductor (e.g. naive-compaction mid-summary)
	 * leaves an uncancelled, billable model call running against an orphaned store, which then
	 * fires its completion callbacks into the void (harmless thanks to the host identity guard,
	 * but wasted spend and a lifecycle leak).
	 *
	 * Deliberately NOT `detach()`: the kill switch freezes the conductor-folded view into
	 * human-owned folds and refolds so the human keeps steering AFTER the conductor leaves. A
	 * store that is about to be thrown away has no view to preserve and no one left to steer it,
	 * so `dispose()` skips the freeze/refold and only tears down the conductor lifecycle.
	 * Idempotent: a second call detaches a null conductor (a no-op).
	 */
	dispose(): void {
		this.detachConductorHost(this.conductor);
		this.conductor = null;
	}

	/**
	 * ADR 0011 consent → baseline. Clear standing human/agent overrides in the domains the
	 * attaching conductor locks: under `human-steering` every HUMAN override (pin / manual
	 * fold / manual unfold) AND every human-owned GROUP is released; under `agent-unfold` every
	 * AGENT sticky unfold is released. Conductor-owned state (`subst`/`autoFolded`,
	 * `by:"auto"/"conductor"`) is left for the normal `clearConductorState` reset in the refold
	 * that follows. No-op when the conductor locks nothing — so collaborative attach is unchanged.
	 *
	 * Human groups are part of the `human-steering` domain (a multiblock fold is human steering),
	 * so they must be released too — otherwise a stale human group sits in the conductor's field
	 * and `createGroup` (which refuses overlap with ANY existing group) clamps the conductor's own
	 * group over that range, blocking it from authoring the very view the lock handed it. Legacy
	 * absent-`by` groups are treated as human here, the same as everywhere else.
	 */
	private releaseLockedDomains(locks: readonly LockName[]): void {
		const lockHuman = hasLock(locks, "human-steering");
		const lockAgent = hasLock(locks, "agent-unfold");
		if (!lockHuman && !lockAgent) return;
		for (const b of this.blocks) {
			const human = b.by === "you" && (b.override === "pinned" || b.override === "folded" || b.override === "unfolded");
			const agentUnfold = b.by === "agent" && b.override === "unfolded";
			if ((lockHuman && human) || (lockAgent && agentUnfold)) {
				b.override = null;
				b.by = null;
				b.subst = undefined;
			}
		}
		// Release human-owned (and legacy absent-`by`) groups so the conductor authors from a clean
		// field. Conductor groups (`by:"auto"/"conductor"`) are not the human's to release here —
		// `clearConductorState` rebuilds those from the next pass's `group` commands.
		if (lockHuman && this.groups.length) {
			const kept = this.groups.filter((g) => g.by === "auto" || g.by === "conductor");
			if (kept.length !== this.groups.length) this.groups = kept;
		}
	}

	/**
	 * ADR 0011 consent → baseline for a REMOTE conductor (FIX 4). `attach()` runs the
	 * locked-domain release synchronously, but a remote conductor's `locks` are not known at
	 * attach time — they arrive later in `conductor/hello`. The live layer calls this once the
	 * hello lands so standing human/agent holds in the now-known locked domains are released to
	 * the same clean baseline an in-process exclusive conductor authors from, then re-folds.
	 *
	 * Crucially it also updates the reactive `activeLocks` snapshot (via `syncLocks()`), which is
	 * what actually propagates the just-arrived locks to the UI: the remote runner mutated its
	 * `locks` field IN PLACE, so `store.conductor` still points at the same object and a reader of
	 * `store.conductor.locks` is never re-tracked. Reassigning the `$state` snapshot is the
	 * reference change Svelte needs — that, not the `version` bump in `refold()`, is what makes the
	 * consent dialog and locked chrome appear for a remote exclusive conductor (Bug #1). No-op for a
	 * collaborative (locks-nothing) conductor — same as attach.
	 */
	reconcileLocks(): void {
		// Update the reactive snapshot first so the release below — and every subsequent gate —
		// reads the freshly-declared locks.
		this.syncLocks();
		this.releaseLockedDomains(this.conductor?.locks ?? []);
		this.refold();
	}

	/**
	 * ADR 0011 kill-switch mechanics: inherit the conductor's tail boundary into the host's
	 * `protectTokens` so detach causes NO snap-back, then convert the CURRENT conductor-folded
	 * view into sticky, human-owned folds so the subsequent conductor-less refold leaves it
	 * folded (not raw). Runs BEFORE `conductor` is nulled, so `isLocked`/`isFolded`/
	 * `groupWire` still reflect the live conductor's state.
	 *
	 * TAIL INHERITANCE: if the conductor held `tail-size`, its `activeTailTokens` becomes the
	 * new `protectTokens`. Because `protectedFromIndex` uses the same walk-back algorithm for
	 * both the locked and unlocked path, the boundary is IDENTICAL before and after detach —
	 * no block newly enters the protected tail, so `healProtected` never fires on the detach
	 * refold, and the budget is not re-blown. The human's prior `protectTokens` is overwritten;
	 * a subsequently attached collaborative conductor runs with the inherited value until the
	 * human re-drags the slider. If the conductor did not hold `tail-size`, `protectTokens` is
	 * left untouched.
	 *
	 * FOLD FREEZE: a block the human already holds (`override !== null`) is untouched. A block
	 * the conductor folds individually (via `autoFolded`/`subst`, `override === null`, NOT
	 * inside a folded group) becomes `override:"folded"`, `by:"you"`, individually reversible.
	 * Members of a folded group are NOT individually frozen here — the group itself IS the
	 * frozen view. This matters because group collapse legitimately includes non-foldable kinds
	 * (`user`, `tool_call`) whose individual `override:"folded"` would be an illegal wire state.
	 *
	 * The conductor's `subst` is PRESERVED, not cleared, so the kill switch freezes the EXACT
	 * on-screen view. For a digest-folding conductor (built-in) `subst` is already
	 * `undefined`, so the block freezes to the engine digest exactly as before. For a
	 * `replace`-based conductor (naive compaction) `subst` carries the generated summary —
	 * preserving it means detach keeps the summary visible rather than reverting to a generic
	 * digest. A conductor-owned folded group is reassigned to `by:"you"` so
	 * `clearConductorState` keeps it.
	 * From then on the normal heal-and-prune invariant governs: if the HUMAN later grows the
	 * protected tail over a detach-frozen fold or group, `healProtected`/`pruneProtectedGroups`
	 * handles it as an ordinary human override — "position one."
	 */
	private freezeForDetach(): void {
		// TAIL INHERITANCE: inherit the conductor's tail boundary so the post-detach
		// `protectedFromIndex` is stable (no snap-back, no re-blow). Direct field assign —
		// NOT setProtect (which is gated under the tail-size lock, which we still hold here).
		if (this.isLocked("tail-size")) {
			this.protectTokens = this.activeTailTokens;
		}
		for (const b of this.blocks) {
			if (b.override !== null) continue; // human already owns it — leave as-is
			if (!this.isFolded(b)) continue; // live (or straggler in an open group) — nothing to freeze
			// Skip members of a FOLDED group — that group itself is the frozen view (reassigned to
			// the human below), and individually stamping `override:"folded"` on a `user`/`tool_call`
			// member would be illegal on the wire (`wireFoldable` refuses non-foldable kinds as
			// per-block folds) — the view↔wire divergence this repo forbids. But a member of an
			// OPEN group that the conductor folded INDIVIDUALLY has no folded-group view to preserve
			// it, so it MUST be frozen here like any other block (it is necessarily a foldable kind —
			// `substOne`'s `wireFoldable` gate is the only way it got folded). Gate on the group's
			// FOLDED state, not mere membership, or such a fold reopens on the next pass (the kill
			// switch would fail to freeze it — @a-Fig review, comment 1 variant).
			if (this.inFoldedGroup(b.id)) continue;
			b.override = "folded";
			b.by = "you";
			// `subst` is intentionally NOT cleared (see docstring) — freeze the exact view.
			// State hygiene: the fold is now a human override, not a conductor auto-fold —
			// clear the stale `autoFolded` left over from the conductor pass.
			b.autoFolded = false;
		}
		// Reassign any folded conductor/auto group to the human so the subsequent raw pass
		// keeps it. The group is the frozen view — its members keep override===null, so
		// `groupWire` shadows them in `isFolded`/`effTokens` exactly as before detach; no
		// individual `override:"folded"` is ever written on a non-foldable member.
		let touched = false;
		const reassigned = this.groups.map((g) => {
			if (g.folded && (g.by === "auto" || g.by === "conductor")) {
				touched = true;
				return { ...g, by: "you" as Actor };
			}
			return g;
		});
		if (touched) this.groups = reassigned;
	}

	private reindex(): void {
		this.index.clear();
		for (let i = 0; i < this.blocks.length; i++) this.index.set(this.blocks[i].id, i);
	}

	private clearConductorStatus(): void {
		this.conductorStatus.text = "";
		this.conductorStatus.metrics = {};
	}

	/**
	 * Build the host-capabilities object the store hands to a conductor on attach.
	 *
	 * A fresh object is built once per `attach()` call and handed to the conductor's
	 * `attach(host)`. The conductor holds the reference for its lifetime; `requestRerun()`
	 * captures this attach's epoch while the capability methods read through live store state,
	 * so `can("complete")` reflects a model link becoming available or disappearing later.
	 */
	private buildHost(forConductor: Conductor, epoch: number): ConductorHost {
		const store = this;
		return {
			can(capability) {
				if (capability === "complete") {
					return store.conductor === forConductor && store.conductorEpoch === epoch && store.completer != null;
				}
				if (capability === "countTokens") return true;
				if (capability === "digest") return true;
				return false;
			},
			complete(req: CompletionRequest): Promise<CompletionResult> {
				if (store.conductor !== forConductor || store.conductorEpoch !== epoch) {
					return Promise.reject(new Error("stale conductor host"));
				}
				if (!store.completer) return Promise.reject(new Error("completion capability unavailable"));
				return store.completer(req);
			},
			countTokens(text: string): number {
				return estTokens(text);
			},
			digestOf(id: string): string | null {
				const b = store.get(id);
				return b ? digest(b) : null;
			},
			setStatus(text: string | null, metrics: Record<string, number | string | boolean> = {}): void {
				if (store.conductor !== forConductor || store.conductorEpoch !== epoch) return;
				store.conductorStatus.text = text ?? "";
				store.conductorStatus.metrics = text ? metrics : {};
			},
			requestRerun: () => store.requestConductorRerun(forConductor, epoch),
		};
	}

	/** Give the current in-process conductor a host API, if it asked for one. */
	private attachConductorHost(c: Conductor | null): void {
		if (!c?.attach) return;
		const epoch = this.conductorEpoch;
		try {
			c.attach(this.buildHost(c, epoch));
		} catch (e) {
			// Lifecycle failures are conductor bugs, not store bugs. Keep the model-call path live
			// and let the upcoming refold fall back to the conductor's normal `conduct()` handling.
			this.emit("conductor", "conductor attach error", e instanceof Error ? e.message : String(e));
		}
	}

	/** Notify the old conductor it no longer owns this store; lifecycle bugs must not wedge us. */
	private detachConductorHost(c: Conductor | null): void {
		if (!c?.detach) return;
		try {
			c.detach();
		} catch (e) {
			this.emit("conductor", "conductor detach error", e instanceof Error ? e.message : String(e));
		}
	}

	/**
	 * Async bridge for in-process conductors. A conductor may finish work after `conduct()`
	 * returned `null`; this schedules exactly one later pass for a burst of completions. The
	 * captured conductor + epoch make late completions from a detached conductor harmless.
	 */
	private requestConductorRerun(c: Conductor, epoch: number): void {
		if (this.conductor !== c || this.conductorEpoch !== epoch) return;
		if (this.conductorRerunQueuedFor) return;
		const token = { conductor: c, epoch };
		this.conductorRerunQueuedFor = token;
		const enqueue = typeof queueMicrotask === "function" ? queueMicrotask : (fn: () => void) => Promise.resolve().then(fn);
		enqueue(() => {
			if (this.conductorRerunQueuedFor !== token) return;
			this.conductorRerunQueuedFor = null;
			if (this.conductor !== c || this.conductorEpoch !== epoch) return;
			this.refold();
		});
	}

	// ---- reads -------------------------------------------------------------
	isFolded(b: Block): boolean {
		// A member of a FOLDED group: collapsed → reads folded; straggler → reads live.
		const w = this.groupWire.get(b.id);
		if (w) return w.collapsed;
		if (b.override === "folded") return true;
		if (b.override === "pinned" || b.override === "unfolded") return false;
		return b.autoFolded;
	}
	/** Tokens this block currently costs the live context. */
	effTokens(b: Block): number {
		// Inside a folded group the contribution is the group's, not the block's own
		// (carrier holds the one summary's tokens; other collapsed members hold 0).
		const w = this.groupWire.get(b.id);
		if (w) return w.tokens;
		if (!this.isFolded(b)) return b.tokens;
		// Folded: a conductor's (non-empty) substitution costs its own length; otherwise the
		// engine's per-kind digest. (substOne normalizes an empty "" replace to the digest path.)
		return b.subst !== undefined ? substTokens(b.subst) : digestTokens(b);
	}
	/** What a folded block renders / the agent receives: the conductor's substitution if any,
	 * else the engine's per-kind digest (which carries the `{#code FOLDED}` recovery tag). */
	digestOf(b: Block): string {
		return b.subst ?? digest(b);
	}

	// These aggregates are read many times per render (the header alone reads several
	// repeatedly). As `$derived` they walk the blocks once per real change and dedupe
	// across every reader, instead of re-summing ~1k blocks on each property access.
	liveTokens = $derived.by(() => {
		let n = 0;
		for (const b of this.blocks) n += this.effTokens(b);
		return n;
	});
	/** What the context would cost with nothing folded. (Only changes when blocks change.) */
	fullTokens = $derived.by(() => {
		let n = 0;
		for (const b of this.blocks) n += b.tokens;
		return n;
	});
	savedTokens = $derived.by(() => this.fullTokens - this.liveTokens);
	foldedCount = $derived.by(() => {
		let n = 0;
		for (const b of this.blocks) if (this.isFolded(b)) n++;
		return n;
	});
	overBudget = $derived.by(() => this.liveTokens > this.budget);

	// ---- groups (multiblock folds, ADR 0006) -------------------------------
	/** blockId → the group it belongs to (if any). Reactive on `groups`. */
	private groupAt = $derived.by(() => {
		const m = new Map<string, Group>();
		for (const g of this.groups) for (const id of g.memberIds) m.set(id, g);
		return m;
	});
	/**
	 * For every block inside a FOLDED group, its effective live contribution + folded
	 * state — so `effTokens`/`isFolded` mirror exactly what the wire does (ADR 0006 §5):
	 * the carrier holds the one summary's tokens, other collapsed members hold 0, and a
	 * straggler (split tool-pair half) stays live at full. Reactive on `groups`/`blocks`.
	 * Blocks NOT in a folded group are absent → callers fall back to per-block logic.
	 */
	private groupWire = $derived.by(() => {
		const m = new Map<string, { tokens: number; collapsed: boolean }>();
		for (const g of this.groups) {
			if (!g.folded) continue;
			const c = this.classifyGroup(g);
			// Carrier token cost mirrors groupLiveTokens: drop → 0, custom digest → its tokens,
			// default recap → groupDigestTokens. Non-carrier collapsed members always 0.
			let summaryTok = 0;
			if (c.carrier) {
				if (this.isDropGroup(g)) summaryTok = 0; // drop group
				else if (typeof g.digest === "string") summaryTok = estTokens(g.digest) + BLOCK_OVERHEAD; // custom literal
				else summaryTok = groupDigestTokens(g, c.collapsedMembers); // default recap
			}
			for (const b of c.members) {
				if (c.collapsed.has(b.id)) m.set(b.id, { tokens: b.id === c.carrier ? summaryTok : 0, collapsed: true });
				else m.set(b.id, { tokens: b.tokens, collapsed: false }); // straggler: live, full
			}
		}
		return m;
	});

	/**
	 * Split a group's members into what collapses (whole, tool-pair-balanced messages →
	 * the one summary) vs. what stays live (a tool-pair half whose partner sits outside the
	 * group — the owner's "leave straggler live" rule). Pure; no durability gate here (that
	 * is the WIRE's concern in `plan.ts` — the GUI shows the logical collapse so the demo /
	 * loaded sessions render real savings).
	 */
	private classifyGroup(g: Group): GroupShape {
		const members: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) members.push(b);
		}
		// Pairing WITHIN the member set: a tool_call is balanced iff its result is also a
		// member; a tool_result iff its call is. A block whose partner is outside is a straggler.
		const memberCalls = new Set<string>();
		const memberResults = new Set<string>();
		for (const b of members) {
			if (!b.callId) continue;
			if (b.kind === "tool_call") memberCalls.add(b.callId);
			else if (b.kind === "tool_result") memberResults.add(b.callId);
		}
		const balanced = (b: Block): boolean => {
			if (b.kind === "tool_call") return !b.callId || memberResults.has(b.callId);
			if (b.kind === "tool_result") return !b.callId || memberCalls.has(b.callId);
			return true;
		};
		// Removal is per MESSAGE: a message collapses only if ALL its member blocks are
		// balanced (so a message holding an unbalanced tool_call stays whole/live).
		const byMsg = new Map<string, Block[]>();
		for (const b of members) {
			const k = messageKey(b.id);
			const arr = byMsg.get(k);
			if (arr) arr.push(b);
			else byMsg.set(k, [b]);
		}
		const removable = new Set<string>(); // message keys that collapse
		for (const [k, msgBlocks] of byMsg) if (msgBlocks.every(balanced)) removable.add(k);
		const collapsed = new Set<string>();
		const stragglers = new Set<string>();
		const collapsedMembers: Block[] = [];
		for (const b of members) {
			if (removable.has(messageKey(b.id))) {
				collapsed.add(b.id);
				collapsedMembers.push(b);
			} else stragglers.add(b.id);
		}
		return { members, collapsedMembers, collapsed, stragglers, carrier: collapsedMembers[0]?.id ?? null };
	}

	/**
	 * Index of the first protected block. The same walk-back algorithm runs in all cases:
	 * walking back from the newest block, protect whole blocks until the token target is
	 * reached, refusing to pull in the next older block if doing so would exceed a strict
	 * 25% whole-block overflow cap. That keeps the slider honest: 20k means roughly 20k,
	 * not 40k just because a huge boundary block happened to cross the threshold.
	 *
	 * ADR 0011 `tail-size` lock: the active conductor's `activeTailTokens` (0 if omitted)
	 * replaces `protectTokens` as the target. With `activeTailTokens === 0` the walk-back
	 * never runs (target 0 → blocks.length), identical to today's "conductor owns the whole
	 * context." With `activeTailTokens > 0` the conductor declares a protected tail of its
	 * own, protecting the newest ~N tokens — so only older blocks arrive with
	 * `protected: false`. Absent the lock, `protectTokens` drives the walk-back exactly as
	 * before — the collaborative/golden path is byte-identical.
	 *
	 * Protection remains absolute for what IS inside the tail, and we always protect at
	 * least the newest block when target > 0. A single newest block may exceed the cap by
	 * itself — the cap only decides whether to add another older block.
	 */
	protectedFromIndex = $derived.by(() => {
		if (!this.blocks.length) return 0;
		// Under tail-size the conductor's activeTailTokens drives the walk-back; without the
		// lock the human's protectTokens drives it. Both follow exactly the same algorithm.
		const target = this.isLocked("tail-size") ? this.activeTailTokens : this.protectTokens;
		// target === 0: protection disabled — every block is foldable (or the conductor
		// owns the whole context). blocks.length ⇒ isProtected is false everywhere.
		if (target === 0) return this.blocks.length;
		const cap = target * PROTECT_OVERFLOW_CAP;
		// Always absorb the newest block unconditionally — it is indivisible and the
		// protected tail must never be empty while target > 0.
		let sum = this.blocks[this.blocks.length - 1].tokens;
		if (sum >= target) return this.blocks.length - 1;
		for (let i = this.blocks.length - 2; i >= 0; i--) {
			const next = sum + this.blocks[i].tokens;
			// Stop before adding an older block that would push the protected tail beyond
			// the overflow cap.
			if (next > cap) return i + 1;
			sum = next;
			if (sum >= target) return i;
		}
		return 0;
	});
	/**
	 * Is this block inside the protected working tail (never auto-folded)? Resolves the
	 * block by id, so `b` MUST be store-owned (from `blocks`/`get`) — a foreign object that
	 * merely shares an id resolves to the committed block's position. Every caller passes a
	 * store block today; an off-store/wire/ghost block is out of contract here.
	 */
	isProtected(b: Block): boolean {
		return (this.index.get(b.id) ?? -1) >= this.protectedFromIndex;
	}
	/** Full tokens currently held in the protected tail. */
	protectedTokens = $derived.by(() => {
		let n = 0;
		for (let i = this.protectedFromIndex; i < this.blocks.length; i++) n += this.blocks[i].tokens;
		return n;
	});

	// ---- the automatic folder ---------------------------------------------
	/**
	 * Dissolve any group that has come to reach into the protected tail (ADR 0006 watch
	 * item). Groups are created entirely older than the tail, but widening `protectTokens`
	 * can later grow the tail over an existing group. Protection is absolute, so rather than
	 * collapse protected content we drop the whole group — keeping the grid (older box uses
	 * the display list, protected box renders raw tiles) and the accounting consistent.
	 *
	 * After a tail-size-conductor detach the host inherits the conductor's `tailTokens` into
	 * `protectTokens` (ADR 0011 §6), so the boundary is stable across detach and no group is
	 * newly swept into the protected tail by the detach itself. If the HUMAN later grows the
	 * tail over a detach-frozen group (e.g. via `setProtect`), this prune fires as normal —
	 * "position one" — the group is dropped and its members become live protected blocks.
	 */
	private pruneProtectedGroups(): void {
		if (!this.groups.length) return;
		const pf = this.protectedFromIndex;
		const kept = this.groups.filter((g) => {
			const reaches = g.memberIds.some((id) => (this.index.get(id) ?? Infinity) >= pf);
			if (reaches) this.emit("auto", "ungrouped (protected)", `${g.memberIds.length} blocks`);
			return !reaches;
		});
		if (kept.length !== this.groups.length) this.groups = kept;
	}

	/**
	 * Recompute the conductor-controlled view from scratch so the live context reflects
	 * the active strategy. Idempotent: same blocks + budget + overrides + conductor →
	 * same result. Named `refold` for history and for the ~30 callers that already invoke
	 * it; it now delegates to whatever conductor is attached (the built-in folder by
	 * default, or none ⇒ raw).
	 */
	refold(): void {
		this.runConductor();
	}

	/**
	 * One conductor pass (ADR 0007). The shape mirrors the pre-seam `refold` exactly so
	 * the built-in stays byte-identical, but the fold DECISION now lives in the conductor:
	 *
	 *   1. prune groups that reach into the protected tail (engine invariant);
	 *   2. heal a manual fold the protected tail has grown over (engine invariant);
	 *   3. clear conductor-owned state → the baseline the conductor folds down FROM;
	 *   4. ask the conductor for its desired command set;
	 *   5. apply it, clamping each command to provider-validity.
	 *
	 * Non-reentrant: a `group` command routes through `createGroup`, which calls `refold`
	 * again — the latch makes that inner call a no-op so the outer pass owns the result.
	 */
	private runConductor(): void {
		if (this.conducting) return;
		this.conducting = true;
		try {
			// A group can never overlap the protected tail; drop any that now does (e.g. the
			// tail was widened over it) before anything reads group state this pass.
			this.pruneProtectedGroups();
			// Compute the protected boundary once; folding never changes a block's full
			// `tokens`, so this index is stable for the whole pass.
			const protectedFrom = this.protectedFromIndex;

			// Engine invariant — protection is ABSOLUTE: a block in the working tail is never
			// folded, by a conductor OR the user. Heal a manual fold the tail has grown over
			// (e.g. the tail widened via setProtect) so it springs back to live.
			this.healProtected(protectedFrom);
			// Reset conductor-owned state to the raw baseline (human overrides + groups still
			// apply); the snapshot's liveTokens is then exactly what the conductor folds down from.
			this.clearConductorState();
			this.version++;

			// Ask the active conductor for its complete desired state. `null` ⇒ hold the last
			// applied batch (a remote one still thinking); `[]` ⇒ clear to raw; no conductor ⇒ raw.
			let result: Command[] | null;
			try {
				result = this.conductor ? this.conductor.conduct(this.buildView(protectedFrom)) : [];
			} catch (e) {
				// A buggy conductor (first-party, not an adversary) must never wedge the store or
				// abort the live model-call path. Hold the last applied state and surface the error.
				result = null;
				this.emit("conductor", "conductor error", e instanceof Error ? e.message : String(e));
			}
			const cmds = result === null ? this.lastCmds : result;
			// Every conductor's folds are attributed uniformly — no conductor is special by id.
			const by: Actor = "auto";
			const reports = this.applyCommands(cmds, by);
			this.lastReports = reports;
			if (result !== null) this.lastCmds = cmds;

			for (const r of reports) {
				// Skip `noop` reports to the activity log. `by` is always "auto" in a conductor
				// pass, so a conductor issuing pin/restore on already-live blocks would otherwise
				// spam "clamped · noop" on every refold. The wire still receives them via
				// `lastReports` (assigned above). Non-noop clamps (protected, unknown-id, …)
				// are always logged so they are visible in the activity feed.
				if (r.reason === "noop") continue;
				this.emit(by, `clamped · ${r.reason}`, r.detail);
			}
		} finally {
			this.conducting = false;
		}
	}

	/** Engine invariant: force-unfold any manual fold that now sits in the protected tail. */
	private healProtected(protectedFrom: number): void {
		this.blocks.forEach((b, i) => {
			if (i >= protectedFrom && b.override === "folded") {
				// Protection is absolute, but do not silently erase the user intent — log the
				// forced unfold so the activity feed shows what happened.
				this.emit(b.by ?? "auto", "unfolded (protected)", label(b));
				b.override = null;
				b.by = null;
			}
		});
	}

	/**
	 * Clear everything a conductor owns on blocks the human has NOT overridden — returning
	 * them to full, live content — AND drop every conductor/auto-owned group. Human overrides
	 * (pin / manual fold / manual unfold) and HUMAN groups (`by:"you"`) are left untouched;
	 * they are not the conductor's to reset. Conductor groups (`by !== "you"`) are dropped so
	 * each pass rebuilds its groups from the current `group` command batch — otherwise a group
	 * the conductor stops asking for (returns `[]`, or is detached) would strand folded forever.
	 */
	private clearConductorState(): void {
		for (const b of this.blocks) {
			if (b.override === null) {
				b.autoFolded = false;
				b.subst = undefined;
				if (b.by === "auto" || b.by === "conductor") b.by = null;
			}
		}
		// Drop conductor/auto groups (by:"auto" or by:"conductor"); keep human and absent-by
		// groups. Absent `by` means a legacy or test-constructed group literal with no
		// provenance set — preserve it, same as a human group. Only explicit conductor
		// provenance is rebuilt from scratch each pass. Reassign only if something changed so
		// the reactive `groups` (and its derived maps) don't churn on every clean pass.
		const humanGroups = this.groups.filter((g) => g.by !== "auto" && g.by !== "conductor");
		if (humanGroups.length !== this.groups.length) this.groups = humanGroups;
	}

	/**
	 * Build the ONE public view every conductor consumes — pure, serializable data, the same
	 * surface the wire ships (`ViewBlock`). Taken AFTER the reset, so `liveTokens` is the
	 * baseline the conductor folds down from. The built-in folder reads exactly this; there
	 * is no privileged richer input. Per-block flags fold the host's policy into plain bools
	 * so a conductor needn't call any engine helper: `held` = a human override owns it,
	 * `folded` = currently rendered folded, `protected` = inside the working tail, `grouped`
	 * = member of a folded group, `foldedTokens` = the digest's token cost (or full `tokens`
	 * for a non-foldable kind, which cannot shrink — so a conductor's `foldedTokens < tokens`
	 * shrink test naturally skips `user`/`tool_call` and never proposes a fold the host clamps).
	 */
	private buildView(protectedFrom: number): ConductorView {
		const blocks = this.blocks.map((b, i) => ({
			id: b.id,
			kind: b.kind,
			turn: b.turn,
			order: b.order,
			tokens: b.tokens,
			foldedTokens: wireFoldable(b) ? digestTokens(b) : b.tokens,
			toolName: b.toolName,
			callId: b.callId,
			isError: b.isError,
			held: b.override !== null,
			folded: this.isFolded(b),
			protected: i >= protectedFrom,
			grouped: this.groupWire.has(b.id),
			text: b.text,
		}));
		return {
			blocks,
			budget: this.budget,
			contextWindow: this.contextWindow,
			liveTokens: this.liveTokens,
			protectedFromIndex: protectedFrom,
			// Under tail-size the conductor sees ITS OWN tail target — the same value that
			// drove `protectedFromIndex`. Absent the lock, the human's `protectTokens` is passed
			// as before (collaborative/golden path unchanged).
			protectTokens: this.isLocked("tail-size") ? this.activeTailTokens : this.protectTokens,
		};
	}

	/**
	 * Apply a conductor's command batch to the (already-cleared) baseline. This is the
	 * ONE place the host enforces its single floor — provider-validity — by clamping:
	 * every command is content substitution (a block is never removed, so a tool pair
	 * never orphans), a human override always wins, and a grouped block is left to its
	 * group. Returns one ClampReport per command it could not apply verbatim — never
	 * throws, never silently drops. Public for tests and the remote runner; production
	 * always reaches it through `runConductor` (which does the reset first).
	 */
	applyCommands(cmds: Command[], by: Actor): ClampReport[] {
		const reports: ClampReport[] = [];
		for (const c of cmds) {
			switch (c.kind) {
				case "fold":
					for (const id of c.ids) this.substOne(id, c.digest, by, "fold", reports);
					break;
				case "replace":
					this.substOne(c.id, c.content, by, "replace", reports);
					break;
				case "restore":
				case "pin":
					for (const id of c.ids) this.liveOne(id, by, c.kind, reports);
					break;
				case "group":
					this.groupCmd(c.ids, by, reports, c.digest);
					break;
			}
		}
		return reports;
	}

	/**
	 * Fold/replace one block by content substitution. `content === undefined` (a fold with
	 * no digest) marks it folded via the engine digest — byte-identical to the old
	 * auto-folder; a non-empty string substitutes that exact content; an empty string `""`
	 * can't be a wire content part, so it folds to the engine digest too (see the body).
	 */
	private substOne(id: string, content: string | undefined, by: Actor, kind: "fold" | "replace", reports: ClampReport[]): void {
		const b = this.get(id);
		if (!b) return void reports.push(clamp(kind, [id], "unknown-id", `no block ${id}`));
		if (b.override !== null) return void reports.push(clamp(kind, [id], "human-override", `${label(b)} is held by the human`));
		if (this.groupWire.has(id)) return void reports.push(clamp(kind, [id], "grouped", `${label(b)} is inside a folded group`));
		// Protection is ABSOLUTE: a block in the working tail is never folded, by a conductor
		// OR the user. Refuse and report rather than violate the safety pillar.
		if (this.isProtected(b)) return void reports.push(clamp(kind, [id], "protected", `${label(b)} is in the protected working tail`));
		// One foldability gate, shared with the wire (`wireFoldable`). A kind the wire would
		// never fold — `user` (intent) or `tool_call` (folding it orphans its result) — is
		// refused here and REPORTED, never silently applied. Without this a conductor's
		// fold/replace on such a block sets `subst` (so the view recesses the tile and counts
		// the saving) while `computeFoldOps` drops it on the wire — the agent gets the block
		// whole. That is the exact divergence the host must make unrepresentable.
		if (!wireFoldable(b)) return void reports.push(clamp(kind, [id], "not-foldable", `${label(b)} is a ${b.kind}; only text/thinking/tool_result fold on the wire`));
		b.autoFolded = true;
		// An empty replacement can't be represented on the wire — a fold must leave a non-empty
		// content part (`computeFoldOps` drops an empty digest), so `subst=""` would recess the
		// tile and count the saving while the agent still receives the block whole. Fall back to
		// the engine digest (the smallest wire-safe form) so the view matches what the wire sends.
		b.subst = content === "" ? undefined : content;
		b.by = by;
	}

	/** Force a block back to full, live content (restore/pin). No-op if already live. */
	private liveOne(id: string, by: Actor, kind: "restore" | "pin", reports: ClampReport[]): void {
		const b = this.get(id);
		if (!b) return void reports.push(clamp(kind, [id], "unknown-id", `no block ${id}`));
		if (b.override !== null) return void reports.push(clamp(kind, [id], "human-override", `${label(b)} is held by the human`));
		if (this.groupWire.has(id)) return void reports.push(clamp(kind, [id], "grouped", `${label(b)} is inside a folded group`));
		// Already live: the documented contract is to REPORT the no-op, not silently swallow it.
		if (!b.autoFolded && b.subst === undefined) return void reports.push(clamp(kind, [id], "noop", `${label(b)} is already live`));
		b.autoFolded = false;
		b.subst = undefined;
		if (b.by === "auto" || b.by === "conductor") b.by = null;
	}

	/**
	 * Apply a `group` command by reusing the human group machinery (contiguous, ≥1,
	 * ungrouped, older than the tail). Human always wins: if SNAPPING the range would sweep
	 * a human-held block (pinned / manually folded / manually unfolded) into the collapse,
	 * refuse the whole group and report it — never silently override the human's choice.
	 * (Human-initiated groups go straight through `createGroup` and keep their old freedom.)
	 */
	private groupCmd(ids: string[], by: Actor, reports: ClampReport[], digest?: string | null): void {
		if (ids.length < 1) return void reports.push(clamp("group", ids, "invalid-group", "a group needs ≥1 block"));
		const range = this.snappedRange(ids[0], ids[ids.length - 1]);
		if (range) {
			const held = range.filter((id) => this.get(id)?.override != null);
			if (held.length)
				return void reports.push(clamp("group", ids, "human-override", `would collapse ${held.length} human-held block(s)`));
		}
		const g = this.createGroup(ids[0], ids[ids.length - 1], by, digest);
		if (!g) reports.push(clamp("group", ids, "invalid-group", "not a valid contiguous, ungrouped run older than the protected tail"));
	}

	setBudget(n: number): void {
		this.budget = Math.max(1000, Math.round(n));
		this.refold();
	}

	setContextWindow(n: number): void {
		this.contextWindow = n;
	}

	/**
	 * Live mode: ingest blocks streamed from the pi link, then re-fold. Blocks
	 * arrive in conversation order and are append-only (the live context grows;
	 * folding is the only mutation, and that is the store's own decision).
	 *
	 * Idempotent by durable id. The same block may arrive twice — streamed early
	 * when pi finishes it (the `message_end` view sync), then again in the next
	 * `context` full-array reconcile or a structural resync. The first arrival
	 * commits the block; a repeat id is dropped, so any user fold state already on
	 * that block is preserved (we never touch a block that is already present). The
	 * source of truth therefore never holds two blocks with the same id — including
	 * a duplicate id within a single batch.
	 */
	appendBlocks(blocks: Block[]): void {
		if (!blocks.length) return;
		const fresh: Block[] = [];
		for (const b of blocks) {
			if (this.index.has(b.id)) continue; // already committed (or dup within this batch)
			this.index.set(b.id, this.blocks.length + fresh.length);
			fresh.push(b);
		}
		if (!fresh.length) return;
		this.blocks.push(...fresh);
		this.refold();
	}

	/** Resize the protected working tail, then re-fold so the change takes effect. */
	setProtect(n: number): void {
		// ADR 0011 `tail-size` lock: the human can no longer resize the tail — the conductor
		// owns it. No-op (no refold) so the dial is inert under the lock, in every mode.
		if (this.isLocked("tail-size")) return;
		this.protectTokens = Math.max(0, Math.round(n));
		this.refold();
	}

	// ---- manual actions ----------------------------------------------------
	private emit(by: Actor, action: string, detail: string): void {
		this.log.unshift({ by, action, detail, n: this.logN++ });
		if (this.log.length > 80) this.log.pop();
	}

	/**
	 * A block inside a FOLDED group is controlled by its parent tile, not per-block
	 * overrides: the group's collapse already decides its fate (ADR 0006 §2). Refuse
	 * fold/unfold/pin/unpin here so a human pin is never silently swallowed by the
	 * group's wire state (the override would be recorded but `groupWire` would ignore
	 * it). Unfold the group first to act on a member. No-op while the group is OPEN.
	 */
	private inFoldedGroup(id: string): boolean {
		return this.groupAt.get(id)?.folded ?? false;
	}

	/**
	 * Can the human fold this block right now? The single predicate the UI consults to decide
	 * whether to OFFER a Fold affordance — it mirrors EXACTLY the conditions under which
	 * `fold()` will act, so the view never shows a dead/ineffective Fold control: the kind must
	 * be wire-foldable, and the block must not be protected, already inside a folded group, or
	 * human-pinned.
	 */
	canFold(b: Block): boolean {
		return wireFoldable(b) && !this.isProtected(b) && !this.inFoldedGroup(b.id) && b.override !== "pinned";
	}

	fold(id: string, by: Actor = "you"): void {
		// ADR 0011 `human-steering` lock: a human hand-fold is refused outright — no override
		// written, no log, no onHumanOverride. There is no human override to "win" under the lock.
		if (this.humanLocked(by)) return;
		const b = this.get(id);
		if (!b || b.override === "pinned" || this.inFoldedGroup(id)) return;
		// Protected working tail is never folded — not even by an explicit user action.
		// (Pin it or widen the budget instead; protection is the safety pillar.)
		if (this.isProtected(b)) return;
		// Shared foldability gate (`wireFoldable`, same predicate the wire enforces): a manual
		// fold on a non-foldable kind (user / tool_call) is refused, so the view can never show
		// a per-block fold the agent would still receive whole. Group collapse is a separate path.
		if (!wireFoldable(b)) return;
		b.override = "folded";
		b.by = by;
		// The human is taking control: drop any conductor substitution so this folds to the
		// engine digest (with its {#code FOLDED} recovery tag), not stale conductor text.
		b.subst = undefined;
		this.emit(by, "folded", label(b));
		this.refold();
		if (by === "you") this.onHumanOverride?.([id], "folded");
	}
	unfold(id: string, by: Actor = "you"): void {
		// ADR 0011: two separate lock axes flow through this one method.
		//  • human-steering gates the human's hand-unfold (`by === "you"`).
		//  • agent-unfold gates the agent's `unfold` tool (`by === "agent"`, via resolveUnfold).
		// A refused agent unfold is a silent no-op here; `resolveUnfold` VERIFIES the block is
		// still folded after calling and records the refusal as "missing" (FIX 3) — this method
		// does not signal the refusal itself.
		if (this.humanLocked(by)) return;
		if (by === "agent" && this.isLocked("agent-unfold")) return;
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "unfolded";
		b.by = by;
		b.subst = undefined; // human override clears conductor-owned content
		this.emit(by, "unfolded", label(b));
		this.refold();
		if (by === "you") this.onHumanOverride?.([id], "unfolded");
	}
	toggle(id: string, by: Actor = "you"): void {
		// ADR 0011 `human-steering`: gate early so a locked human toggle is a true no-op
		// (fold/unfold are also gated, but gating here avoids reading state under the lock).
		if (this.humanLocked(by)) return;
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
		// ADR 0011 `human-steering`: pin is human-only steering — refused under the lock.
		if (this.humanLocked("you")) return;
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "pinned";
		b.by = "you";
		b.subst = undefined; // human override clears conductor-owned content
		this.emit("you", "pinned", label(b));
		this.refold();
		this.onHumanOverride?.([id], "pinned");
	}
	unpin(id: string): void {
		// ADR 0011 `human-steering`: unpin is human-only steering — refused under the lock.
		if (this.humanLocked("you")) return;
		const b = this.get(id);
		if (!b || b.override !== "pinned") return;
		b.override = null;
		b.by = "you";
		this.emit("you", "unpinned", label(b));
		this.refold();
		this.onHumanOverride?.([id], "unpinned");
	}
	/** Hand a block back to the automatic folder. */
	auto(id: string): void {
		// ADR 0011 `human-steering`: clearing an override by hand is human steering — refused
		// under the lock (the human can't reach in to re-auto a block the conductor owns).
		if (this.humanLocked("you")) return;
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return; // group controls collapsed members (like fold/pin)
		b.override = null;
		b.by = null;
		this.refold();
	}
	/** Clear every manual override AND dissolve every group — pure budget view (back to auto). */
	resetAll(): void {
		// ADR 0011 `human-steering`: reset is a sweeping human steering action — refused
		// wholesale under the lock (no overrides cleared, no log, no notify).
		if (this.isLocked("human-steering")) return;
		for (const b of this.blocks) {
			b.override = null;
			b.by = null;
		}
		// "Pure budget view" means NO manual fold construct survives — groups included. Drop every
		// group; an attached conductor rebuilds its own (`by:"auto"/"conductor"`) groups on the
		// refold below, so in practice this clears only HUMAN groups. Without it, a human-owned
		// group — including a detach-frozen view whose inherited 0-tail leaves no protected tail to
		// prune it — would survive reset still folded, silently contradicting "all blocks to auto".
		if (this.groups.length) this.groups = [];
		this.emit("you", "reset", "all blocks to auto");
		this.refold();
		// Empty id list = "everything changed"; the conductor reconciles from the next update.
		this.onHumanOverride?.([], "reset");
	}

	// ---- group actions (multiblock folds, ADR 0006) -----------------------
	/** The group a block belongs to, if any. */
	groupOf(b: Block): Group | undefined {
		return this.groupAt.get(b.id);
	}
	groupById(id: string): Group | undefined {
		return this.groups.find((g) => g.id === id);
	}
	groupMembers(g: Group): Block[] {
		const out: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) out.push(b);
		}
		return out;
	}
	/** True iff this group should emit NO wire message — a drop group (digest null or ""). */
	isDropGroup(g: Group): boolean {
		return g.digest === null || g.digest === "";
	}

	/** The one summary string the group's folded tile renders / the agent receives. */
	groupSummary(g: Group): string {
		if (this.isDropGroup(g)) return ""; // drop group: caller must branch on isDropGroup first
		if (typeof g.digest === "string" && g.digest) return g.digest; // non-empty literal → verbatim
		const c = this.classifyGroup(g);
		return groupDigest(g, c.collapsedMembers.length ? c.collapsedMembers : c.members);
	}
	/** Full tokens of the whole range, ignoring fold state. */
	groupFullTokens(g: Group): number {
		let n = 0;
		for (const b of this.groupMembers(g)) n += b.tokens;
		return n;
	}
	/** What the group costs live: folded → one summary (+ any straggler full); open → members' own eff. */
	groupLiveTokens(g: Group): number {
		if (!g.folded) {
			let n = 0;
			for (const b of this.groupMembers(g)) n += this.effTokens(b);
			return n;
		}
		const c = this.classifyGroup(g);
		// Drop group: the carrier contributes 0 (no wire message inserted).
		// Custom-digest group: the carrier contributes the literal summary's token cost.
		// Default recap group: carrier contributes the group digest tokens (unchanged).
		let carrierTokens = 0;
		if (c.carrier) {
			if (this.isDropGroup(g)) {
				carrierTokens = 0;
			} else if (typeof g.digest === "string" && g.digest) {
				carrierTokens = estTokens(g.digest) + BLOCK_OVERHEAD;
			} else {
				carrierTokens = groupDigestTokens(g, c.collapsedMembers);
			}
		}
		let n = carrierTokens;
		for (const id of c.stragglers) n += this.get(id)?.tokens ?? 0;
		return n;
	}
	groupSavedTokens(g: Group): number {
		return this.groupFullTokens(g) - this.groupLiveTokens(g);
	}
	/** How many members stay LIVE on the wire (split tool-pair halves) — surfaced in the tooltip. */
	groupStragglerCount(g: Group): number {
		return g.folded ? this.classifyGroup(g).stragglers.size : 0;
	}

	/**
	 * The member ids a group over [startId, endId] would cover, after SNAPPING outward to
	 * whole messages (a group never splits an assistant message's parts). Null if either id
	 * is unknown. Pure — no validation, no mutation; shared by `createGroup` and the
	 * conductor's `group` command so both reason over the exact same final range.
	 */
	private snappedRange(startId: string, endId: string): string[] | null {
		const i0 = this.index.get(startId);
		const i1 = this.index.get(endId);
		if (i0 === undefined || i1 === undefined) return null;
		let lo = Math.min(i0, i1);
		let hi = Math.max(i0, i1);
		const keyLo = messageKey(this.blocks[lo].id);
		while (lo > 0 && messageKey(this.blocks[lo - 1].id) === keyLo) lo--;
		const keyHi = messageKey(this.blocks[hi].id);
		while (hi < this.blocks.length - 1 && messageKey(this.blocks[hi + 1].id) === keyHi) hi++;
		const ids: string[] = [];
		for (let i = lo; i <= hi; i++) ids.push(this.blocks[i].id);
		return ids;
	}

	/**
	 * Create a group from a block range (the human's selection, any two member ids). The
	 * range is SNAPPED outward to whole messages (never splits an assistant message's parts),
	 * then validated: entirely older than the protected tail, no member already grouped
	 * (no overlap), ≥1 member. Folds it on creation. Returns the group, or null if invalid.
	 *
	 * `digest` is the optional conductor-supplied summary override (mirrors `GroupCommand.digest`):
	 * `undefined` → default recap; `null`/`""` → drop (no wire message); non-empty string → verbatim.
	 */
	createGroup(startId: string, endId: string, by: Actor = "you", digest?: string | null): Group | null {
		// ADR 0011 `human-steering`: a human hand-group is refused under the lock. The
		// conductor's own group command routes here with by="auto"/"conductor" and is NOT
		// gated (it is the conductor steering, not the human).
		if (this.humanLocked(by)) return null;
		const memberIds = this.snappedRange(startId, endId);
		if (!memberIds) return null;
		// Never reach into the protected tail (ADR 0006 §1).
		if ((this.index.get(memberIds[memberIds.length - 1]) ?? Infinity) >= this.protectedFromIndex) return null;
		for (const id of memberIds) {
			if (this.groupAt.get(id)) return null; // overlap with an existing group
		}
		if (memberIds.length < 1) return null;
		const g: Group = { id: `g:${memberIds[0]}`, memberIds, folded: true, by, digest };
		// A group must actually collapse something. If EVERY member is a split tool-pair half
		// (its partner sits outside the range), nothing folds into the summary — the tile would
		// hide live blocks for zero benefit. That isn't a fold; refuse it (ADR 0006 §4: a folded
		// group replaces its blocks WITH the parent summary).
		if (this.classifyGroup(g).carrier === null) return null;
		this.groups = [...this.groups, g];
		// A conductor group is recreated EVERY pass, so emitting "grouped" each time would spam
		// the activity log — exactly as conductor block-folds emit nothing per fold. Only the
		// human's one-time group action is logged.
		if (by === "you") this.emit(by, "grouped", `${memberIds.length} blocks`);
		this.refold();
		return g;
	}
	/** Delete a group (members return to normal). The UI's "edit membership" is delete + recreate. */
	deleteGroup(id: string, by: Actor = "you"): void {
		if (this.humanLocked(by)) return; // ADR 0011 `human-steering`
		const g = this.groupById(id);
		if (!g) return;
		this.groups = this.groups.filter((x) => x.id !== id);
		this.emit(by, "ungrouped", `${g.memberIds.length} blocks`);
		this.refold();
	}
	foldGroup(id: string, by: Actor = "you"): void {
		if (this.humanLocked(by)) return; // ADR 0011 `human-steering`
		const g = this.groupById(id);
		if (!g || g.folded) return;
		g.folded = true;
		this.groups = [...this.groups];
		this.emit(by, "group folded", `${g.memberIds.length} blocks`);
		this.refold();
	}
	unfoldGroup(id: string, by: Actor = "you"): void {
		if (this.humanLocked(by)) return; // ADR 0011 `human-steering`
		// ADR 0011 `agent-unfold` (FIX 2): mirror the per-block `unfold` gate. `resolveUnfold`
		// routes a folded GROUP code here with by="agent", so without this the agent could
		// unfold a group straight through the lock. Refused agent group-unfolds become "missing"
		// in `resolveUnfold` (it verifies the group is still folded after this call).
		if (by === "agent" && this.isLocked("agent-unfold")) return;
		const g = this.groupById(id);
		if (!g || !g.folded) return;
		g.folded = false;
		this.groups = [...this.groups];
		this.emit(by, "group unfolded", `${g.memberIds.length} blocks`);
		this.refold();
	}
	toggleGroup(id: string, by: Actor = "you"): void {
		if (this.humanLocked(by)) return; // ADR 0011 `human-steering`
		const g = this.groupById(id);
		if (!g) return;
		g.folded ? this.unfoldGroup(id, by) : this.foldGroup(id, by);
	}

	get(id: string): Block | undefined {
		const i = this.index.get(id);
		return i === undefined ? undefined : this.blocks[i];
	}
}

function label(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

/** Build a ClampReport (host clamped a command to the validity floor instead of dropping it). */
function clamp(command: Command["kind"], ids: string[], reason: ClampReason, detail: string): ClampReport {
	return { command, ids, reason, detail };
}

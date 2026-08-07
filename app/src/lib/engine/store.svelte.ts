/*
 * store.svelte.ts — the app's reactive view over the framework-free Truth core.
 *
 * The canonical context state (block log, overlay, groups, protected tail, locks, budget) lives in
 * `core/truth.ts` — the single source of truth, host-agnostic (the same class runs authoritatively
 * in the extension in Phase B). This store is a THIN wrapper: it holds a `Truth` instance, forwards
 * every mutation through `truth.apply(...)` / the config paths, and keeps a reactive `$state` MIRROR
 * of the truth in lockstep by consuming the `TruthEvent`s the truth emits through ONE function,
 * `applyTruthEvent`. Phase B reuses that exact function to apply events arriving over a WebSocket.
 *
 * The public API (getters, action signatures) is unchanged so UI components and `plan.ts` don't
 * churn — a getter that used to compute state now either reads the mirror or forwards to truth.
 */
import type { Block, Actor, SessionMeta, ParsedSession, Group } from "./types";
import type { LockName } from "./locks";
import { hasLock } from "./locks";
import { Truth } from "$core/truth";
import type { Op } from "$core/ops";
import type { TruthEvent } from "$core/events";
import { applyWireEvent } from "$core/replica";
import { resolveUnfold as coreResolveUnfold, resolveRecall as coreResolveRecall } from "$core/agentView";
import type { WireEvent, WireCommand, FoldOp, GroupOp } from "$core/protocol";

function cloneBlock(b: Block): Block {
	return {
		id: b.id,
		kind: b.kind,
		turn: b.turn,
		order: b.order,
		text: b.text, // shared string reference — cheap
		tokens: b.tokens,
		toolName: b.toolName,
		callId: b.callId,
		model: b.model,
		isError: b.isError,
		override: b.override,
		autoFolded: b.autoFolded,
		by: b.by,
		subst: b.subst,
	};
}
function cloneGroup(g: Group): Group {
	return { id: g.id, memberIds: g.memberIds.slice(), folded: g.folded, by: g.by, digest: g.digest };
}

export class AccordionStore {
	readonly meta: SessionMeta;
	private truth: Truth;

	// ── reactive mirror of the truth ────────────────────────────────────────
	/** $state clones of the truth's blocks (overlay synced from truth on every event). */
	blocks = $state<Block[]>([]);
	/** $state clones of the truth's groups. Direct assignment (`store.groups = [...]`) is a raw
	 *  injection seam — it forwards into truth so group accounting stays authoritative. */
	private _groups = $state<Group[]>([]);
	get groups(): Group[] {
		return this._groups;
	}
	set groups(v: Group[]) {
		this.assertLocalMode("groups");
		this.truth.setGroups(v);
		this._groups = this.truth.groups.map(cloneGroup);
		this.version++;
	}
	budget = $state(70_000);
	contextWindow = $state<number | null>(null);
	protectTokens = $state(20_000);
	/** Bumped on every truth event — the reactive redraw signal the forwarded reads depend on. */
	version = $state(0);

	private _locks = $state<readonly LockName[]>([]);
	private _holder = $state<string | null>(null);
	private _activeTail = $state(0);

	private mirrorIndex = new Map<string, number>();

	/**
	 * Phase B command sink. When set (live mode), the store is a REPLICA + remote control: human
	 * steering actions are forwarded to the wire as `WireCommand`s instead of applied to the local
	 * Truth. The authoritative extension applies them and the resulting events echo back through
	 * `replayEvent` — no optimistic apply, so the mirror only ever moves via the event stream.
	 * Null (local mode: CC / file / demo) ⇒ actions apply directly to the local Truth as before.
	 */
	private commandSink: ((cmd: WireCommand) => void) | null = null;

	/**
	 * @param parsed        the parsed session (local mode). For a live replica, pass `existingTruth`.
	 * @param existingTruth a pre-built (Phase B: replica-hydrated, rev-aligned) Truth to wrap; the
	 *                      mirror seeds from IT, and `parsed` is ignored except as a type placeholder.
	 */
	constructor(parsed: ParsedSession, existingTruth?: Truth) {
		this.truth = existingTruth ?? new Truth(parsed);
		this.meta = this.truth.meta;
		this.truth.onEvent((e) => this.applyTruthEvent(e));
		// Seed the mirror from the truth's initial (post-construction) state.
		this.blocks = this.truth.blocks.map(cloneBlock);
		this.rebuildMirrorIndex();
		this._groups = this.truth.groups.map(cloneGroup);
		this.budget = this.truth.budget;
		this.contextWindow = this.truth.contextWindow;
		this.protectTokens = this.truth.protectTokens;
		this._locks = this.truth.locks;
		this._holder = this.truth.lockHolder;
		this._activeTail = this.truth.activeTailTokens;
	}

	private rebuildMirrorIndex(): void {
		this.mirrorIndex.clear();
		for (let i = 0; i < this.blocks.length; i++) this.mirrorIndex.set(this.blocks[i].id, i);
	}

	/**
	 * The single seam that projects a TruthEvent into the reactive mirror. Phase B applies events
	 * that arrive over the WebSocket through this exact function.
	 */
	private applyTruthEvent(e: TruthEvent): void {
		switch (e.type) {
			case "appended":
				for (const b of e.blocks) {
					this.mirrorIndex.set(b.id, this.blocks.length);
					this.blocks.push(cloneBlock(b));
				}
				this.syncOverlay(); // healing may have touched older blocks
				this.syncGroups(); // append housekeeping (pruneProtectedGroups) can touch groups too
				break;
			case "ops-applied":
				this.syncOverlay();
				this.syncGroups();
				break;
			case "config":
				this.syncOverlay();
				this.syncGroups();
				if (e.budget !== undefined) this.budget = e.budget;
				if (e.contextWindow !== undefined) this.contextWindow = e.contextWindow;
				if (e.protectTokens !== undefined) this.protectTokens = e.protectTokens;
				break;
			case "locks":
				this.syncOverlay();
				this.syncGroups();
				this._locks = e.locks;
				this._holder = e.holder;
				this._activeTail = e.tailTokens;
				break;
			case "reset":
				this.syncOverlay();
				this.syncGroups();
				break;
			case "sent":
				break; // no overlay change; just a redraw
		}
		this.version++;
	}

	/** Copy the truth's per-block overlay onto the mirror clones (in place → reactive). */
	private syncOverlay(): void {
		for (const mb of this.blocks) {
			const tb = this.truth.get(mb.id);
			if (!tb) continue;
			if (mb.override !== tb.override) mb.override = tb.override;
			if (mb.autoFolded !== tb.autoFolded) mb.autoFolded = tb.autoFolded;
			if (mb.by !== tb.by) mb.by = tb.by;
			if (mb.subst !== tb.subst) mb.subst = tb.subst;
		}
	}
	private syncGroups(): void {
		this._groups = this.truth.groups.map(cloneGroup);
	}

	// ── Phase B: replica + remote control ───────────────────────────────────
	/** Install (live mode) / clear (local mode) the wire command sink. */
	setCommandSink(sink: ((cmd: WireCommand) => void) | null): void {
		this.commandSink = sink;
	}
	/** True iff human actions route to the wire (live mode) rather than the local Truth. */
	get wireControlled(): boolean {
		return this.commandSink !== null;
	}
	/**
	 * Guard for the six mutators (`setContextWindow`, `appendBlocks`, `setLocks`, `clearLocks`, the
	 * `groups` setter, the `wireAttached` setter) that write wire FACTS straight to the local Truth
	 * instead of routing through `commandSink` like fold/pin/setBudget/setProtect do. In live replica
	 * mode that wire input arrives ONLY via `replayEvent` (called by `liveClient.svelte.ts`), which
	 * mutates the underlying Truth directly through `applyWireEvent` — it never calls these methods.
	 * So calling one of these WHILE a command sink is installed is never correct: it would locally
	 * fork the replica away from the host instead of waiting for the echoed event. Throws
	 * unconditionally (no local-mode/live-mode split) — there is no live-mode caller these could ever
	 * legitimately serve.
	 */
	private assertLocalMode(name: string): void {
		if (this.commandSink) {
			throw new Error(`AccordionStore.${name}() is local-only — it must not be called in live replica mode (state arrives via replayEvent)`);
		}
	}
	/** The Truth's monotonic rev — the replica gap-check anchor. */
	get rev(): number {
		return this.truth.rev;
	}
	/** Replay a serialized host event onto the (replica) Truth; the mirror updates via `onEvent`. */
	replayEvent(ev: WireEvent): void {
		applyWireEvent(this.truth, ev);
	}
	/** Route a steering op transaction to the wire when live, else apply it to the local Truth. */
	private applyOps(ops: Op[], by: Actor): void {
		if (this.commandSink && by === "you") {
			this.commandSink({ kind: "ops", ops });
			return;
		}
		this.truth.apply(ops, by);
	}
	/** The wire fold ops for the current state (view-over-truth; used by the fold-alarm diagnostic + tests). */
	computeFoldOps(): FoldOp[] {
		return this.truth.computeFoldOps();
	}
	/** The wire group-collapse ops for the current state (view-over-truth). */
	computeGroupOps(): GroupOp[] {
		return this.truth.computeGroupOps();
	}
	/**
	 * Agent unfold/recall resolution against the underlying Truth. In production this runs
	 * extension-side (core/agentView over the authoritative Truth); these thin passthroughs expose
	 * it for read-only/CC contexts and the live-layer tests. NOTE: `resolveUnfold` MUTATES the
	 * Truth locally — never call it on a live REPLICA (steering must route through the command sink).
	 */
	resolveUnfold(codes: string[]) {
		return coreResolveUnfold(this.truth, codes);
	}
	resolveRecall(codes: string[]) {
		return coreResolveRecall(this.truth, codes);
	}

	// ── reads (forward to truth; reactive via `version`) ────────────────────
	get(id: string): Block | undefined {
		const i = this.mirrorIndex.get(id);
		return i === undefined ? undefined : this.blocks[i];
	}
	isFolded(b: Block): boolean {
		void this.version;
		return this.truth.isFolded(b);
	}
	effTokens(b: Block): number {
		void this.version;
		return this.truth.effTokens(b);
	}
	digestOf(b: Block): string {
		void this.version;
		return this.truth.digestOf(b);
	}
	isProtected(b: Block): boolean {
		void this.version;
		return this.truth.isProtected(b);
	}
	canFold(b: Block): boolean {
		void this.version;
		return this.truth.canFold(b, "you");
	}

	liveTokens = $derived.by(() => (void this.version, this.truth.liveTokens()));
	fullTokens = $derived.by(() => (void this.version, this.truth.fullTokens()));
	savedTokens = $derived.by(() => this.fullTokens - this.liveTokens);
	foldedCount = $derived.by(() => (void this.version, this.truth.foldedCount()));
	overBudget = $derived.by(() => this.liveTokens > this.budget);
	protectedFromIndex = $derived.by(() => (void this.version, this.truth.protectedFromIndex()));
	protectedTokens = $derived.by(() => (void this.version, this.truth.protectedTokens()));

	// ── involvement locks ───────────────────────────────────────────────────
	isLocked(name: LockName): boolean {
		return hasLock(this._locks, name);
	}
	get locks(): readonly LockName[] {
		return this._locks;
	}
	get lockHolder(): string | null {
		return this._locks.length ? this._holder : null;
	}
	/** The tail target the holder ENFORCES while holding `tail-size` (0 when not held). The PROTECT
	 *  readout shows this under the lock, not the human's stale `protectTokens`. */
	get activeTailTokens(): number {
		return this._activeTail;
	}

	// ── the wire-attached flag (local-mode / test seam) ─────────────────────
	// In live mode the replica's `wireAttached` arrives baked into the snapshot/`adoptSnapshot`
	// (hydrateSnapshot sets it on the Truth directly) — this setter is for local/demo sessions that
	// want to simulate a live wire (e.g. group-accounting cross-validation tests), so it is guarded
	// the same as the other five wire-fact mutators below.
	get wireAttached(): boolean {
		return this.truth.wireAttached;
	}
	set wireAttached(v: boolean) {
		this.assertLocalMode("wireAttached");
		if (this.truth.wireAttached === v) return;
		this.truth.wireAttached = v; // bumps the truth rev → group accounting recomputes
		this.version++;
	}

	// ── config dials ────────────────────────────────────────────────────────
	// Budget + protect are human dials → route to the wire in live mode. contextWindow, append,
	// and locks are wire FACTS — in live mode they arrive over the wire as `event`s and are applied
	// by `replayEvent` (→ `applyWireEvent`) DIRECTLY against the Truth, bypassing these methods
	// entirely. So these methods are local-mode-only (demo / CC / file / tests); `assertLocalMode`
	// refuses a live-mode call rather than let it silently fork the replica from the host.
	setBudget(n: number): void {
		if (this.commandSink) {
			this.commandSink({ kind: "setBudget", value: n });
			return;
		}
		this.truth.setBudget(n);
	}
	setContextWindow(n: number): void {
		this.assertLocalMode("setContextWindow");
		this.truth.setContextWindow(n);
	}
	setProtect(n: number): void {
		if (this.commandSink) {
			this.commandSink({ kind: "setProtect", value: n });
			return;
		}
		this.truth.setProtect(n);
	}
	appendBlocks(blocks: Block[]): void {
		this.assertLocalMode("appendBlocks");
		this.truth.append(blocks);
	}
	setLocks(locks: readonly LockName[], holder: string, tailTokens = 0): void {
		this.assertLocalMode("setLocks");
		this.truth.setLocks(locks, holder, tailTokens);
	}
	clearLocks(): void {
		this.assertLocalMode("clearLocks");
		this.truth.clearLocks();
	}

	// ── manual actions (route to the wire in live mode, else the single write path) ──
	fold(id: string, by: Actor = "you"): void {
		this.applyOps([{ kind: "fold", ids: [id] }], by);
	}
	unfold(id: string, by: Actor = "you"): void {
		this.applyOps([{ kind: "unfold", ids: [id] }], by);
	}
	toggle(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
		this.applyOps([{ kind: "pin", ids: [id] }], "you");
	}
	unpin(id: string): void {
		this.applyOps([{ kind: "unpin", ids: [id] }], "you");
	}
	auto(id: string): void {
		this.applyOps([{ kind: "auto", ids: [id] }], "you");
	}
	resetAll(): void {
		this.applyOps([{ kind: "resetAll" }], "you");
	}

	// ── group actions ───────────────────────────────────────────────────────
	groupOf(b: Block): Group | undefined {
		void this.version;
		return this.groups.find((g) => g.memberIds.includes(b.id));
	}
	groupById(id: string): Group | undefined {
		void this.version;
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
	isDropGroup(g: Group): boolean {
		return g.digest === null || g.digest === "";
	}
	groupSummary(g: Group): string {
		void this.version;
		const tg = this.truth.groupById(g.id);
		return tg ? this.truth.groupSummary(tg) : "";
	}
	groupFullTokens(g: Group): number {
		void this.version;
		const tg = this.truth.groupById(g.id);
		return tg ? this.truth.groupFullTokens(tg) : 0;
	}
	groupLiveTokens(g: Group): number {
		void this.version;
		const tg = this.truth.groupById(g.id);
		return tg ? this.truth.groupLiveTokens(tg) : 0;
	}
	groupSavedTokens(g: Group): number {
		void this.version;
		const tg = this.truth.groupById(g.id);
		return tg ? this.truth.groupSavedTokens(tg) : 0;
	}
	groupStragglerCount(g: Group): number {
		void this.version;
		const tg = this.truth.groupById(g.id);
		return tg ? this.truth.groupStragglerCount(tg) : 0;
	}

	createGroup(startId: string, endId: string, by: Actor = "you", digest?: string | null): Group | null {
		// Live mode: the group materializes when the host's ops-applied event echoes back, so there
		// is no synchronous group to return — return null (callers must not depend on the handle live).
		if (this.commandSink && by === "you") {
			this.commandSink({ kind: "ops", ops: [{ kind: "group", ids: [startId, endId], summary: digest }] });
			return null;
		}
		const r = this.truth.apply([{ kind: "group", ids: [startId, endId], summary: digest }], by);
		const res = r.results[0];
		if (!res || !res.applied || !res.detail) return null;
		return this.groupById(res.detail) ?? null;
	}
	deleteGroup(id: string, by: Actor = "you"): void {
		this.applyOps([{ kind: "ungroup", groupId: id }], by);
	}
	foldGroup(id: string, by: Actor = "you"): void {
		this.applyOps([{ kind: "foldGroup", groupId: id }], by);
	}
	unfoldGroup(id: string, by: Actor = "you"): void {
		this.applyOps([{ kind: "unfoldGroup", groupId: id }], by);
	}
}

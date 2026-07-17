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
import type { Op, OpResult } from "$core/ops";
import type { TruthEvent } from "$core/events";
import { applyWireEvent } from "$core/replica";
import type { WireEvent, WireCommand, FoldOp, GroupOp } from "$core/protocol";

interface LogEntry {
	by: Actor;
	action: string;
	detail: string;
	n: number;
}

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
		this.truth.setGroups(v);
		this._groups = this.truth.groups.map(cloneGroup);
		this.version++;
	}
	budget = $state(70_000);
	contextWindow = $state<number | null>(null);
	protectTokens = $state(20_000);
	log = $state<LogEntry[]>([]);
	/** Bumped on every truth event — the reactive redraw signal the forwarded reads depend on. */
	version = $state(0);

	private _locks = $state<readonly LockName[]>([]);
	private _holder = $state<string | null>(null);
	private _activeTail = $state(0);

	private logN = 0;
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
				this.logFromResults(e.by, e.results);
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
				this.emit("you", "reset", "all blocks to auto");
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

	// ── activity log (built from truth events) ──────────────────────────────
	private emit(by: Actor, action: string, detail: string): void {
		this.log.unshift({ by, action, detail, n: this.logN++ });
		if (this.log.length > 80) this.log.pop();
	}
	private logFromResults(by: Actor, results: OpResult[]): void {
		for (const r of results) {
			if (!r.applied) continue;
			const a = actionFor(r.op);
			if (!a) continue;
			const id = opTargetId(r.op);
			const b = id ? this.get(id) : undefined;
			this.emit(by, a, b ? label(b) : (opTargetId(r.op) ?? ""));
		}
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

	// ── the wire-attached flag (set by the live client) ─────────────────────
	get wireAttached(): boolean {
		return this.truth.wireAttached;
	}
	set wireAttached(v: boolean) {
		if (this.truth.wireAttached === v) return;
		this.truth.wireAttached = v; // bumps the truth rev → group accounting recomputes
		this.version++;
	}

	// ── config dials ────────────────────────────────────────────────────────
	setBudget(n: number): void {
		this.truth.setBudget(n);
	}
	setContextWindow(n: number): void {
		this.truth.setContextWindow(n);
	}
	setProtect(n: number): void {
		this.truth.setProtect(n);
	}
	appendBlocks(blocks: Block[]): void {
		this.truth.append(blocks);
	}
	setLocks(locks: readonly LockName[], holder: string, tailTokens = 0): void {
		this.truth.setLocks(locks, holder, tailTokens);
	}
	clearLocks(): void {
		this.truth.clearLocks();
	}

	// ── manual actions (forward to the single write path) ───────────────────
	fold(id: string, by: Actor = "you"): void {
		this.truth.apply([{ kind: "fold", ids: [id] }], by);
	}
	unfold(id: string, by: Actor = "you"): void {
		this.truth.apply([{ kind: "unfold", ids: [id] }], by);
	}
	toggle(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
		this.truth.apply([{ kind: "pin", ids: [id] }], "you");
	}
	unpin(id: string): void {
		this.truth.apply([{ kind: "unpin", ids: [id] }], "you");
	}
	auto(id: string): void {
		this.truth.apply([{ kind: "auto", ids: [id] }], "you");
	}
	resetAll(): void {
		this.truth.apply([{ kind: "resetAll" }], "you");
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
		const r = this.truth.apply([{ kind: "group", ids: [startId, endId], summary: digest }], by);
		const res = r.results[0];
		if (!res || !res.applied || !res.detail) return null;
		return this.groupById(res.detail) ?? null;
	}
	deleteGroup(id: string, by: Actor = "you"): void {
		this.truth.apply([{ kind: "ungroup", groupId: id }], by);
	}
	foldGroup(id: string, by: Actor = "you"): void {
		this.truth.apply([{ kind: "foldGroup", groupId: id }], by);
	}
	unfoldGroup(id: string, by: Actor = "you"): void {
		this.truth.apply([{ kind: "unfoldGroup", groupId: id }], by);
	}
	toggleGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g) return;
		g.folded ? this.unfoldGroup(id, by) : this.foldGroup(id, by);
	}
}

function label(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

function actionFor(op: Op): string | null {
	switch (op.kind) {
		case "fold":
			return "folded";
		case "unfold":
			return "unfolded";
		case "pin":
			return "pinned";
		case "unpin":
			return "unpinned";
		case "auto":
			return "reverted";
		case "replace":
			return "replaced";
		case "group":
			return "grouped";
		case "ungroup":
			return "ungrouped";
		case "foldGroup":
			return "group folded";
		case "unfoldGroup":
			return "group unfolded";
		case "resetAll":
			return null; // reset is logged from the "reset" event
	}
}
function opTargetId(op: Op): string | undefined {
	if (op.kind === "replace") return op.id;
	if (op.kind === "ungroup" || op.kind === "foldGroup" || op.kind === "unfoldGroup") return op.groupId;
	if (op.kind === "resetAll") return undefined;
	if (op.kind === "group") return op.ids[0];
	return op.ids[0];
}

/*
 * truth.ts — the Truth class: Accordion's canonical context state, framework-free.
 *
 * This is the single source of truth for a session's context: the append-only block log, the
 * per-block overlay (override / autoFolded / subst / by), the multiblock groups, the protected
 * working tail, the involvement locks, and the budget/context-window dials. It owns ALL the
 * fold/group/protect logic — the app's Svelte store is a thin reactive MIRROR over it, and in
 * Phase B this exact class runs authoritatively inside the pi extension.
 *
 * The single write path is `apply(ops, by, baseRev?)`. Config dials have their own evented
 * setters. Every state change bumps a monotonic `rev` and emits one `TruthEvent`; subscribers
 * (`onEvent`) project those into whatever reactive/wire form they need.
 *
 * No Svelte, no runes, no runtime dependencies — plain TypeScript.
 */
import type { Block, Actor, SessionMeta, ParsedSession, Group } from "./types";
import type { LockName } from "./locks";
import { hasLock } from "./locks";
import { digest, digestTokens, substTokens, groupDigest, groupDigestTokens, wireFoldable, foldTag } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";
import { isDurableId, messageInfo, applyPlan, type PiMessage } from "./wire";
import type { WireBlock, FoldOp, GroupOp } from "../app/src/lib/live/protocol";
import type { Op, OpResult, TxnResult, ClampReason } from "./ops";
import type { TruthEvent } from "./events";

/** Classification of a folded group's members for accounting + the wire (ADR 0006 §4/§5). */
interface GroupShape {
	members: Block[];
	collapsedMembers: Block[];
	collapsed: Set<string>;
	stragglers: Set<string>;
	carrier: string | null;
	collapsedRuns: Block[][];
}

/** Aggregate readout of the Truth state (the conductor host's `stats()`). */
export interface TruthStats {
	rev: number;
	liveTokens: number;
	fullTokens: number;
	budget: number;
	contextWindow: number | null;
	protectTokens: number;
	protectedFromIndex: number;
	blockCount: number;
}

/** Whole-block slack allowed above `protectTokens` before the next older block is left foldable. */
const PROTECT_OVERFLOW_CAP = 1.25;

/** A leading `{#code FOLDED}` tag (with surrounding whitespace) a strategy may have baked into a
 *  recoverable `replace` body. Stripped so the engine stays the SOLE author of the tag. */
const LEADING_FOLD_TAG = /^\s*\{#[0-9a-z]{6} FOLDED\}\s*/;

/**
 * The "message key" of a block id — the id with its assistant-part suffix removed, so every part
 * of one assistant message shares a key while scalar user/result/summary blocks stay their own
 * key. Two id regimes share the app (live `…:p<j>`, loaded `<eid>:<j>`); scalar durable ids like
 * `u:<ts>` / `s:<ts>` / `r:<callId>` must NOT be stripped.
 */
export function messageKey(id: string): string {
	const live = id.match(/^(.*):p(?:\d+|\?)$/);
	if (live) return live[1];
	const parsed = id.match(/^(.+):\d+$/);
	if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
	return id;
}

export class Truth {
	readonly meta: SessionMeta;

	// ── state ───────────────────────────────────────────────────────────────
	private blockLog: Block[] = [];
	private groupList: Group[] = [];
	private budgetTok = 70_000;
	private contextWindowTok: number | null = null;
	private protectTokensTarget = 20_000;

	private activeLocks: readonly LockName[] = [];
	private activeTailTok = 0;
	private holderLabel: string | null = null;

	private wireAttachedFlag = false;
	/**
	 * True iff a live pi WIRE is attached. Only in a live session does `classifyGroup` enforce
	 * durability-aware accounting (issue #13). Demo / loaded sessions leave this false. The setter
	 * bumps `rev` on an ACTUAL change (no-op on a same-value set) so the rev-keyed group-accounting
	 * cache (`groupWireCache`) recomputes on a connect/disconnect transition — same "bump rev, no
	 * event" shape as `setGroups` (the caller already knows the value it just set).
	 */
	get wireAttached(): boolean {
		return this.wireAttachedFlag;
	}
	set wireAttached(v: boolean) {
		if (this.wireAttachedFlag === v) return;
		this.wireAttachedFlag = v;
		this.revCounter++;
	}

	/** The highest block `order` that has actually reached the model in an applied plan. */
	private sentThroughOrder = -1;
	/**
	 * Ids of blocks a strategy folded via the birth-fold exemption (folded while protected AND
	 * not-yet-sent). `healProtected` skips these: the model never saw them whole, so the tail
	 * growing over them yanks nothing. A strategy fold of a non-birth (sent / never-protected)
	 * block is NOT here, so it heals when the tail grows over it, exactly as a human fold does.
	 */
	private birthFolded = new Set<string>();

	/** Monotonic; bumps on every state change. Every event carries the post-change value. */
	private revCounter = 0;
	/** Per block/group id → the rev at which it last changed (for `baseRev` stale detection). */
	private lastChangedRev = new Map<string, number>();

	private index = new Map<string, number>();
	private listeners = new Set<(e: TruthEvent) => void>();

	// ── rev-keyed read caches (recomputed lazily when rev changes) ───────────
	private pfiCache = { rev: -1, value: 0 };
	private groupWireCache = { rev: -1, map: new Map<string, { tokens: number; collapsed: boolean }>() };

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blockLog = parsed.blocks.slice();
		this.reindex();
		// Bulk-loaded (non-live) sessions were already part of a completed conversation — none of
		// their blocks is "fresh", so a strategy can never birth-fold history (ADR 0018 §5). A LIVE
		// session constructs EMPTY and streams blocks in, so the cursor starts at -1.
		this.sentThroughOrder = this.blockLog.length ? this.blockLog[this.blockLog.length - 1].order : -1;
	}

	private reindex(): void {
		this.index.clear();
		for (let i = 0; i < this.blockLog.length; i++) this.index.set(this.blockLog[i].id, i);
	}

	// ── events ────────────────────────────────────────────────────────────────
	onEvent(fn: (e: TruthEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	private emit(e: TruthEvent): void {
		for (const fn of this.listeners) fn(e);
	}
	get rev(): number {
		return this.revCounter;
	}

	// ── reads ───────────────────────────────────────────────────────────────
	get blocks(): readonly Block[] {
		return this.blockLog;
	}
	get groups(): readonly Group[] {
		return this.groupList;
	}
	get(id: string): Block | undefined {
		const i = this.index.get(id);
		return i === undefined ? undefined : this.blockLog[i];
	}
	get protectTokens(): number {
		return this.protectTokensTarget;
	}
	get budget(): number {
		return this.budgetTok;
	}
	get contextWindow(): number | null {
		return this.contextWindowTok;
	}
	get locks(): readonly LockName[] {
		return this.activeLocks;
	}
	get lockHolder(): string | null {
		return this.activeLocks.length ? this.holderLabel : null;
	}
	/** The tail target the holder enforces while holding `tail-size` (0 when not held). */
	get activeTailTokens(): number {
		return this.isLocked("tail-size") ? this.activeTailTok : 0;
	}
	isLocked(name: LockName): boolean {
		return hasLock(this.activeLocks, name);
	}

	/** Has this block's content reached the model in an applied plan? */
	sent(b: Block): boolean {
		return b.order <= this.sentThroughOrder;
	}
	/** A human override owns this block (pin / manual fold / manual unfold). */
	held(b: Block): boolean {
		return b.override !== null;
	}

	isFolded(b: Block): boolean {
		const w = this.groupWire().get(b.id);
		if (w) return w.collapsed;
		if (b.override === "folded") return true;
		if (b.override === "pinned" || b.override === "unfolded") return false;
		return b.autoFolded;
	}
	/** Tokens this block currently costs the live context. */
	effTokens(b: Block): number {
		const w = this.groupWire().get(b.id);
		if (w) return w.tokens;
		if (!this.isFolded(b)) return b.tokens;
		return b.subst !== undefined ? substTokens(b.subst) : digestTokens(b);
	}
	/** What a folded block renders / the agent receives: the strategy's subst if any, else the
	 *  engine's per-kind digest (which carries the `{#code FOLDED}` recovery tag). */
	digestOf(b: Block): string {
		return b.subst ?? digest(b);
	}
	/** The folded-token cost of a block (its digest/subst size). */
	foldedTokensOf(b: Block): number {
		return b.subst !== undefined ? substTokens(b.subst) : digestTokens(b);
	}
	messageKeyOf(id: string): string {
		return messageKey(id);
	}

	liveTokens(): number {
		let n = 0;
		for (const b of this.blockLog) n += this.effTokens(b);
		return n;
	}
	fullTokens(): number {
		let n = 0;
		for (const b of this.blockLog) n += b.tokens;
		return n;
	}
	foldedCount(): number {
		let n = 0;
		for (const b of this.blockLog) if (this.isFolded(b)) n++;
		return n;
	}

	stats(): TruthStats {
		return {
			rev: this.revCounter,
			liveTokens: this.liveTokens(),
			fullTokens: this.fullTokens(),
			budget: this.budgetTok,
			contextWindow: this.contextWindowTok,
			protectTokens: this.protectTokensTarget,
			protectedFromIndex: this.protectedFromIndex(),
			blockCount: this.blockLog.length,
		};
	}

	/**
	 * Can `by` fold this block right now? The shared predicate. A human never folds a protected
	 * block; a strategy (`by:"auto"`) MAY fold a protected block via the BIRTH-FOLD exemption iff
	 * the block has not yet been sent (never crossed the wire live, so there is nothing to yank).
	 */
	canFold(b: Block, by: Actor = "you"): boolean {
		if (!wireFoldable(b)) return false;
		if (this.inFoldedGroup(b.id)) return false;
		if (by === "you") {
			if (b.override === "pinned") return false;
			return !this.isProtected(b);
		}
		// strategy / agent path
		if (b.override !== null) return false; // a human override wins
		if (this.isProtected(b)) return !this.sent(b); // birth-fold exemption
		return true;
	}

	// ── protected working tail ──────────────────────────────────────────────
	protectedFromIndex(): number {
		if (this.pfiCache.rev === this.revCounter) return this.pfiCache.value;
		const value = this.computeProtectedFromIndex();
		this.pfiCache = { rev: this.revCounter, value };
		return value;
	}
	private computeProtectedFromIndex(): number {
		const blocks = this.blockLog;
		if (!blocks.length) return 0;
		const target = this.isLocked("tail-size") ? this.activeTailTok : this.protectTokensTarget;
		if (target === 0) return blocks.length;
		const cap = target * PROTECT_OVERFLOW_CAP;
		let sum = blocks[blocks.length - 1].tokens;
		if (sum >= target) return blocks.length - 1;
		for (let i = blocks.length - 2; i >= 0; i--) {
			const next = sum + blocks[i].tokens;
			if (next > cap) return i + 1;
			sum = next;
			if (sum >= target) return i;
		}
		return 0;
	}
	isProtected(b: Block): boolean {
		return (this.index.get(b.id) ?? -1) >= this.protectedFromIndex();
	}
	protectedTokens(): number {
		let n = 0;
		const pf = this.protectedFromIndex();
		for (let i = pf; i < this.blockLog.length; i++) n += this.blockLog[i].tokens;
		return n;
	}

	// ── groups ──────────────────────────────────────────────────────────────
	groupOf(b: Block): Group | undefined {
		for (const g of this.groupList) if (g.memberIds.includes(b.id)) return g;
		return undefined;
	}
	groupById(id: string): Group | undefined {
		return this.groupList.find((g) => g.id === id);
	}
	groupMembers(g: Group): Block[] {
		const out: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) out.push(b);
		}
		return out;
	}
	inFoldedGroup(id: string): boolean {
		for (const g of this.groupList) if (g.folded && g.memberIds.includes(id)) return true;
		return false;
	}
	isDropGroup(g: Group): boolean {
		return g.digest === null || g.digest === "";
	}
	groupSummary(g: Group): string {
		if (this.isDropGroup(g)) return "";
		if (typeof g.digest === "string" && g.digest) return g.digest; // verbatim literal — no tag
		const c = this.classifyGroup(g);
		return groupDigest(g, c.collapsedMembers.length ? c.collapsedMembers : c.members);
	}
	groupFullTokens(g: Group): number {
		let n = 0;
		for (const b of this.groupMembers(g)) n += b.tokens;
		return n;
	}
	groupLiveTokens(g: Group): number {
		if (!g.folded) {
			let n = 0;
			for (const b of this.groupMembers(g)) n += this.effTokens(b);
			return n;
		}
		const c = this.classifyGroup(g);
		let n = c.collapsedRuns.length * this.groupSummaryTok(g, c);
		for (const id of c.stragglers) n += this.get(id)?.tokens ?? 0;
		return n;
	}
	groupSavedTokens(g: Group): number {
		return this.groupFullTokens(g) - this.groupLiveTokens(g);
	}
	groupStragglerCount(g: Group): number {
		return g.folded ? this.classifyGroup(g).stragglers.size : 0;
	}

	private groupWire(): Map<string, { tokens: number; collapsed: boolean }> {
		if (this.groupWireCache.rev === this.revCounter) return this.groupWireCache.map;
		const m = new Map<string, { tokens: number; collapsed: boolean }>();
		for (const g of this.groupList) {
			if (!g.folded) continue;
			const c = this.classifyGroup(g);
			const summaryTok = this.groupSummaryTok(g, c);
			const runFirsts = new Set(c.collapsedRuns.map((r) => r[0].id));
			for (const b of c.members) {
				if (c.collapsed.has(b.id)) m.set(b.id, { tokens: runFirsts.has(b.id) ? summaryTok : 0, collapsed: true });
				else m.set(b.id, { tokens: b.tokens, collapsed: false });
			}
		}
		this.groupWireCache = { rev: this.revCounter, map: m };
		return m;
	}
	private groupSummaryTok(g: Group, c: GroupShape): number {
		if (!c.carrier) return 0;
		if (this.isDropGroup(g)) return 0;
		if (typeof g.digest === "string" && g.digest) return estTokens(g.digest) + BLOCK_OVERHEAD;
		return groupDigestTokens(g, c.collapsedMembers);
	}
	private classifyGroup(g: Group): GroupShape {
		const members: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) members.push(b);
		}
		const byMsg = new Map<string, Block[]>();
		for (const b of members) {
			const k = messageKey(b.id);
			const arr = byMsg.get(k);
			if (arr) arr.push(b);
			else byMsg.set(k, [b]);
		}
		const msgOrder = [...byMsg.keys()];
		const msgCalls = new Map<string, string[]>();
		const msgResults = new Map<string, string[]>();
		for (const k of msgOrder) {
			const calls: string[] = [];
			const results: string[] = [];
			for (const b of byMsg.get(k)!) {
				if (!b.callId) continue;
				if (b.kind === "tool_call") calls.push(b.callId);
				else if (b.kind === "tool_result") results.push(b.callId);
			}
			msgCalls.set(k, calls);
			msgResults.set(k, results);
		}
		const live = this.wireAttached;
		const removable = new Set<string>();
		for (const k of msgOrder) {
			const msgBlocks = byMsg.get(k)!;
			if (live && msgBlocks.some((b) => !isDurableId(b.id))) continue;
			removable.add(k);
		}
		let changed = true;
		do {
			changed = false;
			const calls = new Set<string>();
			const results = new Set<string>();
			for (const k of msgOrder) {
				if (!removable.has(k)) continue;
				for (const c of msgCalls.get(k)!) calls.add(c);
				for (const c of msgResults.get(k)!) results.add(c);
			}
			for (const k of msgOrder) {
				if (!removable.has(k)) continue;
				const unbalanced = msgCalls.get(k)!.some((c) => !results.has(c)) || msgResults.get(k)!.some((c) => !calls.has(c));
				if (unbalanced) {
					removable.delete(k);
					changed = true;
				}
			}
		} while (changed);
		const collapsed = new Set<string>();
		const stragglers = new Set<string>();
		const collapsedMembers: Block[] = [];
		const collapsedRuns: Block[][] = [];
		let run: Block[] | null = null;
		for (const b of members) {
			if (removable.has(messageKey(b.id))) {
				collapsed.add(b.id);
				collapsedMembers.push(b);
				if (run) run.push(b);
				else collapsedRuns.push((run = [b]));
			} else {
				stragglers.add(b.id);
				run = null;
			}
		}
		return { members, collapsedMembers, collapsed, stragglers, carrier: collapsedMembers[0]?.id ?? null, collapsedRuns };
	}

	/**
	 * Raw replace of the group overlay — a test / wire-apply seam that BYPASSES group-op validation
	 * (durability, protected-tail, overlap). Used by the store's `groups` setter to inject groups
	 * the way a wire plan would. Bumps the rev so the rev-keyed accounting caches recompute; emits
	 * no event (the caller projects the mirror itself).
	 */
	setGroups(groups: Group[]): void {
		this.groupList = groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() }));
		this.revCounter++;
	}

	private snappedRange(startId: string, endId: string): string[] | null {
		const i0 = this.index.get(startId);
		const i1 = this.index.get(endId);
		if (i0 === undefined || i1 === undefined) return null;
		let lo = Math.min(i0, i1);
		let hi = Math.max(i0, i1);
		const keyLo = messageKey(this.blockLog[lo].id);
		while (lo > 0 && messageKey(this.blockLog[lo - 1].id) === keyLo) lo--;
		const keyHi = messageKey(this.blockLog[hi].id);
		while (hi < this.blockLog.length - 1 && messageKey(this.blockLog[hi + 1].id) === keyHi) hi++;
		const ids: string[] = [];
		for (let i = lo; i <= hi; i++) ids.push(this.blockLog[i].id);
		return ids;
	}

	// ── append ────────────────────────────────────────────────────────────────
	/** Ingest blocks (idempotent by id). A repeated id is dropped — its fold state is preserved. */
	append(blocks: Block[]): TruthEvent[] {
		if (!blocks.length) return [];
		const fresh: Block[] = [];
		for (const b of blocks) {
			if (this.index.has(b.id)) continue;
			this.index.set(b.id, this.blockLog.length + fresh.length);
			fresh.push(b);
		}
		if (!fresh.length) return [];
		this.blockLog.push(...fresh);
		// The tail may now cover an older manual/strategy fold — housekeep.
		const touched = new Set<string>();
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const b of fresh) this.lastChangedRev.set(b.id, rev);
		for (const id of touched) this.lastChangedRev.set(id, rev);
		const ev: TruthEvent = { type: "appended", blocks: fresh, rev };
		this.emit(ev);
		return [ev];
	}

	// ── config dials ────────────────────────────────────────────────────────
	setBudget(n: number): void {
		this.budgetTok = Math.max(1000, Math.round(n));
		const touched = new Set<string>();
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		this.emit({ type: "config", budget: this.budgetTok, rev });
	}
	setContextWindow(n: number): void {
		this.contextWindowTok = n;
		const rev = ++this.revCounter;
		this.emit({ type: "config", contextWindow: this.contextWindowTok, rev });
	}
	setProtect(n: number): void {
		// The human can no longer resize the tail under the `tail-size` lock (the holder owns it).
		if (this.isLocked("tail-size")) return;
		this.protectTokensTarget = Math.max(0, Math.round(n));
		const touched = new Set<string>();
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		this.emit({ type: "config", protectTokens: this.protectTokensTarget, rev });
	}
	markSent(order: number): void {
		if (order <= this.sentThroughOrder) return;
		this.sentThroughOrder = order;
		const rev = ++this.revCounter;
		this.emit({ type: "sent", throughOrder: this.sentThroughOrder, rev });
	}

	// ── locks (ADR 0011) ──────────────────────────────────────────────────────
	setLocks(locks: readonly LockName[], holder: string, tailTokens = 0): void {
		this.activeLocks = locks.slice();
		this.holderLabel = holder;
		this.activeTailTok = Number.isFinite(tailTokens) ? Math.max(0, Math.round(tailTokens)) : 0;
		const touched = new Set<string>();
		this.releaseLockedDomains(this.activeLocks, touched);
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		this.emit({ type: "locks", locks: this.activeLocks, holder: this.holderLabel, tailTokens: this.activeTailTok, rev });
	}
	clearLocks(): void {
		this.activeLocks = [];
		this.holderLabel = null;
		this.activeTailTok = 0;
		const touched = new Set<string>();
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		this.emit({ type: "locks", locks: this.activeLocks, holder: null, tailTokens: 0, rev });
	}
	private releaseLockedDomains(locks: readonly LockName[], touched: Set<string>): void {
		const lockHuman = hasLock(locks, "human-steering");
		const lockAgent = hasLock(locks, "agent-unfold");
		if (!lockHuman && !lockAgent) return;
		for (const b of this.blockLog) {
			const human = b.by === "you" && (b.override === "pinned" || b.override === "folded" || b.override === "unfolded");
			const agentUnfold = b.by === "agent" && b.override === "unfolded";
			if ((lockHuman && human) || (lockAgent && agentUnfold)) {
				b.override = null;
				b.by = null;
				this.birthFolded.delete(b.id);
				touched.add(b.id);
			}
		}
		if (lockHuman && this.groupList.length) {
			const kept = this.groupList.filter((g) => g.by === "auto");
			if (kept.length !== this.groupList.length) this.groupList = kept;
		}
	}

	// ── housekeeping ──────────────────────────────────────────────────────────
	private housekeep(touched: Set<string>): void {
		this.pruneProtectedGroups(touched);
		this.healProtected(touched);
	}
	private pruneProtectedGroups(touched: Set<string>): void {
		if (!this.groupList.length) return;
		const pf = this.protectedFromIndexUncached();
		const kept = this.groupList.filter((g) => !g.memberIds.some((id) => (this.index.get(id) ?? Infinity) >= pf));
		if (kept.length !== this.groupList.length) {
			for (const g of this.groupList) if (!kept.includes(g)) touched.add(g.id);
			this.groupList = kept;
		}
	}
	/**
	 * Engine invariant — protection is absolute for the human. Heal a HUMAN fold the tail has
	 * grown over, and a STRATEGY fold of a block the model already saw whole. A BIRTH-FOLD (a
	 * strategy fold applied while the block was protected AND unsent) is skipped: the model never
	 * saw it whole, so the tail growing over it yanks nothing.
	 */
	private healProtected(touched: Set<string>): void {
		const pf = this.protectedFromIndexUncached();
		for (let i = pf; i < this.blockLog.length; i++) {
			const b = this.blockLog[i];
			if (b.override === "folded") {
				b.override = null;
				b.by = null;
				touched.add(b.id);
			} else if (b.autoFolded && !this.birthFolded.has(b.id)) {
				b.autoFolded = false;
				b.subst = undefined;
				b.by = null;
				touched.add(b.id);
			}
		}
	}
	/** protectedFromIndex without touching the rev-keyed cache (used mid-mutation before rev bumps). */
	private protectedFromIndexUncached(): number {
		return this.computeProtectedFromIndex();
	}

	// ── the single write path ─────────────────────────────────────────────────
	apply(ops: Op[], by: Actor, baseRev?: number): TxnResult {
		const results: OpResult[] = [];
		const touched = new Set<string>();
		let didReset = false;
		for (const op of ops) {
			const r = this.applyOne(op, by, baseRev, touched);
			results.push(r);
			if (r.applied && op.kind === "resetAll") didReset = true;
		}
		const anyApplied = results.some((r) => r.applied);
		if (!anyApplied) return { rev: this.revCounter, results };
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		if (didReset) {
			// A resetAll batched alongside other ops must not swallow their results: emit an
			// ops-applied event for whatever else applied, THEN the reset — both carry this rev.
			const otherResults = results.filter((r) => r.applied && r.op.kind !== "resetAll");
			if (otherResults.length) this.emit({ type: "ops-applied", by, results: otherResults, rev });
			this.emit({ type: "reset", rev });
		} else {
			this.emit({ type: "ops-applied", by, results, rev });
		}
		return { rev, results };
	}

	private stale(id: string, baseRev?: number): boolean {
		if (baseRev === undefined) return false;
		const lc = this.lastChangedRev.get(id);
		return lc !== undefined && lc > baseRev;
	}

	private applyOne(op: Op, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		switch (op.kind) {
			case "fold":
				return this.opFold(op, by, baseRev, touched);
			case "unfold":
				return this.opUnfold(op, by, baseRev, touched);
			case "pin":
				return this.opPin(op, by, baseRev, touched);
			case "unpin":
				return this.opUnpin(op, by, baseRev, touched);
			case "auto":
				return this.opAuto(op, by, baseRev, touched);
			case "replace":
				return this.opReplace(op, by, baseRev, touched);
			case "group":
				return this.opGroup(op, by, baseRev, touched);
			case "ungroup":
				return this.opUngroup(op, by, baseRev, touched);
			case "foldGroup":
				return this.opFoldGroup(op, by, baseRev, touched);
			case "unfoldGroup":
				return this.opUnfoldGroup(op, by, baseRev, touched);
			case "resetAll":
				return this.opReset(op, by, touched);
		}
	}

	// A per-op result helper.
	private done(op: Op, touched: Set<string>, id: string): OpResult {
		touched.add(id);
		return { op, applied: true };
	}
	private clamp(op: Op, reason: ClampReason, detail?: string): OpResult {
		return { op, applied: false, clamped: reason, detail };
	}

	// Multi-id ops fold their per-id outcome into one result (applied iff ANY id applied).
	private eachId(op: Op & { ids: string[] }, touched: Set<string>, fn: (id: string) => ClampReason | null): OpResult {
		let applied = false;
		let lastClamp: ClampReason | undefined;
		for (const id of op.ids) {
			const c = fn(id);
			if (c === null) {
				applied = true;
				touched.add(id);
			} else {
				lastClamp = c;
			}
		}
		return applied ? { op, applied: true } : { op, applied: false, clamped: lastClamp ?? "noop" };
	}

	private opFold(op: Extract<Op, { kind: "fold" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		return this.eachId(op, touched, (id) => {
			const b = this.get(id);
			if (!b) return "unknown-id";
			if (this.stale(id, baseRev)) return "stale";
			if (this.inFoldedGroup(id)) return "grouped";
			if (!wireFoldable(b)) return "not-foldable";
			if (by === "you") {
				if (b.override === "pinned") return "human-override";
				if (this.isProtected(b)) return "protected";
				b.override = "folded";
				b.by = "you";
				b.subst = undefined;
				this.birthFolded.delete(id);
				return null;
			}
			// strategy fold
			if (b.override !== null) return "human-override";
			if (this.isProtected(b)) {
				if (this.sent(b)) return "protected";
				this.birthFolded.add(id); // birth-fold: protected but never sent whole
			}
			b.autoFolded = true;
			b.by = "auto";
			b.subst = op.digest && op.digest.length ? op.digest : undefined;
			return null;
		});
	}

	private opReplace(op: Extract<Op, { kind: "replace" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		// `replace` is strategy-only. A human never substitutes arbitrary content.
		if (by === "you") return this.clamp(op, "not-foldable", "replace is a strategy op");
		const b = this.get(op.id);
		if (!b) return this.clamp(op, "unknown-id");
		if (this.stale(op.id, baseRev)) return this.clamp(op, "stale");
		if (this.inFoldedGroup(op.id)) return this.clamp(op, "grouped");
		if (b.override !== null) return this.clamp(op, "human-override");
		if (!wireFoldable(b)) return this.clamp(op, "not-foldable");
		if (this.isProtected(b)) {
			if (this.sent(b)) return this.clamp(op, "protected");
			this.birthFolded.add(op.id);
		}
		b.autoFolded = true;
		b.by = "auto";
		const recoverable = op.recoverable ?? true;
		if (op.content === "") {
			b.subst = undefined; // empty can't ride the wire — fold to the engine digest
		} else if (recoverable) {
			b.subst = `${foldTag(op.id)} ${op.content.replace(LEADING_FOLD_TAG, "")}`;
		} else {
			b.subst = op.content;
		}
		return this.done(op, touched, op.id);
	}

	private opUnfold(op: Extract<Op, { kind: "unfold" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		if (by === "agent" && this.isLocked("agent-unfold")) return this.clamp(op, "locked");
		return this.eachId(op, touched, (id) => {
			const b = this.get(id);
			if (!b) return "unknown-id";
			if (this.stale(id, baseRev)) return "stale";
			if (this.inFoldedGroup(id)) return "grouped";
			if (by === "agent") {
				// The agent can only unfold what is actually folded — never downgrade a human pin.
				if (b.override === "pinned") return "human-override";
				if (!this.isFolded(b)) return "noop";
				b.override = "unfolded";
				b.by = "agent";
				this.birthFolded.delete(id);
				return null;
			}
			// human / strategy unfold — hold the block open
			b.override = "unfolded";
			b.by = by;
			b.subst = undefined;
			this.birthFolded.delete(id);
			return null;
		});
	}

	private opPin(op: Extract<Op, { kind: "pin" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		return this.eachId(op, touched, (id) => {
			const b = this.get(id);
			if (!b) return "unknown-id";
			if (this.stale(id, baseRev)) return "stale";
			if (this.inFoldedGroup(id)) return "grouped";
			if (by === "you") {
				b.override = "pinned";
				b.by = "you";
				b.subst = undefined;
				this.birthFolded.delete(id);
				return null;
			}
			// strategy "pin" = assert live (undo its own fold); a human override wins.
			if (b.override !== null) return "human-override";
			if (!b.autoFolded && b.subst === undefined) return "noop";
			b.autoFolded = false;
			b.subst = undefined;
			b.by = null;
			this.birthFolded.delete(id);
			return null;
		});
	}

	private opUnpin(op: Extract<Op, { kind: "unpin" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		return this.eachId(op, touched, (id) => {
			const b = this.get(id);
			if (!b) return "unknown-id";
			if (this.stale(id, baseRev)) return "stale";
			if (b.override !== "pinned") return "noop";
			// A strategy/agent can never destroy a HUMAN pin — same rule every other op enforces.
			if (by !== "you" && b.by === "you") return "human-override";
			b.override = null;
			b.by = by === "you" ? "you" : null;
			return null;
		});
	}

	private opAuto(op: Extract<Op, { kind: "auto" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		return this.eachId(op, touched, (id) => {
			const b = this.get(id);
			if (!b) return "unknown-id";
			if (this.stale(id, baseRev)) return "stale";
			if (this.inFoldedGroup(id)) return "grouped";
			if (by === "you") {
				// Human hands the block back to the strategy (clears a human override).
				b.override = null;
				b.by = null;
				this.birthFolded.delete(id);
				return null;
			}
			// strategy restore — a human override wins; otherwise clear the strategy fold.
			if (b.override !== null) return "human-override";
			if (!b.autoFolded && b.subst === undefined) return "noop";
			b.autoFolded = false;
			b.subst = undefined;
			b.by = null;
			this.birthFolded.delete(id);
			return null;
		});
	}

	private opGroup(op: Extract<Op, { kind: "group" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		if (!op.ids.length) return this.clamp(op, "invalid-group", "a group needs ≥1 block");
		const memberIds = this.snappedRange(op.ids[0], op.ids[op.ids.length - 1]);
		if (!memberIds) return this.clamp(op, "unknown-id");
		if (baseRev !== undefined && memberIds.some((id) => this.stale(id, baseRev))) return this.clamp(op, "stale");
		if ((this.index.get(memberIds[memberIds.length - 1]) ?? Infinity) >= this.protectedFromIndex()) return this.clamp(op, "protected");
		for (const id of memberIds) if (this.groupOf(this.get(id)!)) return this.clamp(op, "invalid-group", "overlaps an existing group");
		// A strategy group must never sweep a human-held block into the collapse.
		if (by !== "you" && memberIds.some((id) => this.get(id)!.override !== null)) return this.clamp(op, "human-override");
		const g: Group = { id: `g:${memberIds[0]}`, memberIds, folded: true, by, digest: op.summary };
		if (this.classifyGroup(g).carrier === null) return this.clamp(op, "invalid-group", "nothing collapses (all stragglers)");
		this.groupList = [...this.groupList, g];
		for (const id of memberIds) touched.add(id);
		touched.add(g.id);
		return { op, applied: true, detail: g.id };
	}

	private opUngroup(op: Extract<Op, { kind: "ungroup" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		const g = this.groupById(op.groupId);
		if (!g) return this.clamp(op, "invalid-group", "no such group");
		if (this.stale(op.groupId, baseRev)) return this.clamp(op, "stale");
		this.groupList = this.groupList.filter((x) => x.id !== op.groupId);
		for (const id of g.memberIds) touched.add(id);
		touched.add(g.id);
		return { op, applied: true };
	}

	private opFoldGroup(op: Extract<Op, { kind: "foldGroup" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		const g = this.groupById(op.groupId);
		if (!g) return this.clamp(op, "invalid-group", "no such group");
		if (this.stale(op.groupId, baseRev)) return this.clamp(op, "stale");
		if (g.folded) return this.clamp(op, "noop");
		g.folded = true;
		this.groupList = [...this.groupList];
		for (const id of g.memberIds) touched.add(id);
		touched.add(g.id);
		return { op, applied: true };
	}

	private opUnfoldGroup(op: Extract<Op, { kind: "unfoldGroup" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		if (by === "agent" && this.isLocked("agent-unfold")) return this.clamp(op, "locked");
		const g = this.groupById(op.groupId);
		if (!g) return this.clamp(op, "invalid-group", "no such group");
		if (this.stale(op.groupId, baseRev)) return this.clamp(op, "stale");
		if (!g.folded) return this.clamp(op, "noop");
		g.folded = false;
		this.groupList = [...this.groupList];
		for (const id of g.memberIds) touched.add(id);
		touched.add(g.id);
		return { op, applied: true };
	}

	private opReset(op: Extract<Op, { kind: "resetAll" }>, by: Actor, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		let changed = this.groupList.length > 0;
		for (const b of this.blockLog) {
			if (b.override !== null || b.autoFolded || b.subst !== undefined || b.by !== null) {
				b.override = null;
				b.autoFolded = false;
				b.subst = undefined;
				b.by = null;
				touched.add(b.id);
				changed = true;
			}
		}
		if (this.groupList.length) {
			for (const g of this.groupList) touched.add(g.id);
			this.groupList = [];
		}
		this.birthFolded.clear();
		if (!changed) return this.clamp(op, "noop");
		return { op, applied: true };
	}

	// ── wire serialization ────────────────────────────────────────────────────
	/**
	 * Compute fold/group ops from the current state and run them through `applyPlan`. Correctness
	 * over cleverness: it reuses the tested `applyPlan`. A per-message cache is a Phase-B option.
	 */
	serializeWire(messages: PiMessage[]): PiMessage[] {
		return applyPlan(messages, this.computeFoldOps(), this.computeGroupOps());
	}
	computeFoldOps(): FoldOp[] {
		const ops: FoldOp[] = [];
		for (const b of this.blockLog) {
			if (!this.isFolded(b)) continue;
			if (this.groupOf(b)?.folded) continue;
			if (!wireFoldable(b)) continue;
			if (!isDurableId(b.id)) continue;
			const digestText = this.digestOf(b);
			if (!digestText) continue;
			ops.push({ id: b.id, digestText });
		}
		return ops;
	}
	computeGroupOps(): GroupOp[] {
		const out: GroupOp[] = [];
		for (const g of this.groupList) {
			if (!g.folded) continue;
			const memberIds = g.memberIds.filter(isDurableId);
			if (!memberIds.length) continue;
			const summaryText: string | null = this.isDropGroup(g) ? null : this.groupSummary(g);
			if (summaryText !== null && !summaryText.trim()) continue;
			out.push({ id: g.id, memberIds, summaryText });
		}
		return out;
	}
}

export type { WireBlock, PiMessage };

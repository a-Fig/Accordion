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
import { isDurableId, applyPlan, computeDegradedDropRuns, roleFloorRecap, type PiMessage, type WireMsgShape } from "./wire";
import type { FoldOp, GroupOp } from "./protocol";
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

/**
 * Aggregate readout of the Truth state (the conductor host's `stats()`).
 *
 * CALIBRATION CONVENTION (issue #11 stage 2, ADR 0025): `liveTokens`/`fullTokens` are calibrated
 * (`Truth.calTokens` applied once to the aggregate) — real, provider-anchored numbers, not the raw
 * chars/4 estimate. `budget`/`protectTokens`/`contextWindow` are NOT converted — they are the
 * literal dial values a human (or a conductor's declared `tailTokens`) set, which stage 2 treats as
 * already meaning REAL tokens (that is the whole point of calibrating the numerator against them:
 * "compaction triggers at 90% of a REAL 70k budget", not "90% of a 70k raw estimate scaled up").
 * `protectedFromIndex` is the boundary index itself (unitless), already computed against the
 * calibrated threshold — see `Truth.protectedFromIndex`'s doc.
 *
 * The SAME convention applies to every other conductor-facing read surface — `ViewBlock.tokens` /
 * `ViewBlock.foldedTokens` (`core/conductor/hostAdapter.ts`'s `viewBlockOf`) and
 * `ConductorHost.countTokens` are ALL calibrated too. This is a deliberate "calibrate at every read
 * surface" choice over the alternative ("stats calibrated, per-block/countTokens stay raw, conductor
 * compares like-with-like itself"): `AgedSummaryConductor` (`conductors/in-process/
 * agedSummaryConductor.ts`) sums `ViewBlock.tokens` directly to build its own trigger baseline
 * (`sumTokens(view.blocks)`), and thermocline's `project()` (`conductors/ws/thermocline/policy.ts`)
 * subtracts per-block `tokens − foldedTokens` from the `stats().fullTokens` baseline it reads via
 * `ConductorHost.stats()` — both mix aggregate and per-block reads in the SAME arithmetic
 * expression, so leaving one calibrated and the other raw would silently corrupt their math (not
 * just under/over-trigger, but genuinely wrong numbers, since a raw-per-block subtraction from a
 * calibrated aggregate baseline is not even the right ORDER of magnitude once `calibration` drifts
 * from 1). Calibrating every read surface means no shipped conductor needed a single code change to
 * become calibration-aware — they already read `ViewBlock.tokens`/`stats()`/`countTokens` and treat
 * whatever those report as the ground truth.
 */
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

/**
 * Recover a block id's WIRE role class — the inverse of `blockId()`'s own `u:`/`a:`/`r:`/`s:`
 * prefix scheme (plus the `m<i>:…` positional fallback). Used ONLY to reconstruct
 * `WireMsgShape.role` for `Truth.degradedRunKeys` (see its doc comment): a live session's block
 * ids already encode which wire-role class produced them, so no real `PiMessage` is needed to
 * tell a user message from an assistant one.
 *
 * Exact for `user` / `assistant` / `toolResult` (each has its own unambiguous prefix). The rare
 * pi "default" message kinds (bash / custom / branchSummary / compactionSummary) all surface as
 * a bare `text` block under an `s:`/`m<i>:s` id (see `linearize`'s `default` branch) — a `Block`
 * alone cannot tell those sub-kinds apart, so they collapse to one `"other"` placeholder. This
 * only under-distinguishes two DIFFERENT non-conversational kinds landing adjacent to each other
 * around a degraded run's boundary — a vanishingly rare shape with no conversational content —
 * never a user/assistant misclassification, which is the case that actually matters for the
 * role-validity floor. A loaded (non-live) session's ids never match ANY of these prefixes (parse.ts
 * uses `<eid>:u` / `<eid>:<i>` / `<eid>:r`), which is fine: `Truth.degradedRunKeys` only builds
 * `WireMsgShape`s when `computeGroupOps()` yields at least one group, and a loaded session's ids
 * are never durable (`isDurableId`), so `computeGroupOps()` already strips them to nothing first.
 */
function wireRoleOfId(id: string): string {
	if (id.startsWith("u:") || /^m\d+:u$/.test(id)) return "user";
	if (id.startsWith("a:") || /^m\d+:p/.test(id)) return "assistant";
	if (id.startsWith("r:") || /^m\d+:r$/.test(id)) return "toolResult";
	return "other"; // "s:" / `m<i>:s`
}

/**
 * How many LOGICAL messages a collapsed run's blocks came from — needed because `roleFloorRecap`'s
 * text is parameterized by MESSAGE count (`applyPlan`'s Phase B counts `messages[]` array
 * positions), while a `GroupShape` run is a `Block[]` and one message can contribute several
 * blocks (e.g. an assistant turn's thinking + text + tool_call). Blocks from the same message are
 * always contiguous (both `linearize` and `parse.ts` emit one message's parts back to back), so a
 * single forward scan counting `messageKey` transitions gives the exact message count.
 */
function messageCountOfRun(run: readonly Block[]): number {
	let n = 0;
	let prevKey: string | null = null;
	for (const b of run) {
		const k = messageKey(b.id);
		if (k !== prevKey) {
			n++;
			prevKey = k;
		}
	}
	return n;
}

export class Truth {
	readonly meta: SessionMeta;

	// ── state ───────────────────────────────────────────────────────────────
	private blockLog: Block[] = [];
	private groupList: Group[] = [];
	private budgetTok = 70_000;
	private contextWindowTok: number | null = null;
	private protectTokensTarget = 20_000;
	/**
	 * Provider-anchored calibration multiplier (issue #11, ADR 0025): `k = realTokens /
	 * estimatedTokens` for the same request, snapped by the HOST ONLY (`setCalibration`, called from
	 * the extension after pairing an assistant reply's real usage against the wire estimate that
	 * produced it). Default 1 — a session that never observes a real pairing (cold start; read-only /
	 * demo / CC / file sessions, which have no live host to ever call the setter) stays at 1 forever.
	 * Stage 1 (display) shipped this dial as read-only plumbing; stage 2 (this) additionally feeds it
	 * into the DECISION surface: `protectedFromIndex()` sizes the protected tail against a calibrated
	 * threshold (see that method's doc), and `stats()` reports calibrated `liveTokens`/`fullTokens`
	 * so a conductor's own budget-trigger math runs on real numbers. `canFold` itself still carries no
	 * token threshold at all (verified — it only ever calls `isProtected`, never compares a token
	 * count), so nothing there needed to change directly; it inherits the calibrated boundary
	 * transitively through `isProtected`/`protectedFromIndex`. See `calTokens`.
	 */
	private calibrationMul = 1;

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
	private sentThroughOrderValue = -1;
	/**
	 * Ids of blocks a strategy folded via the birth-fold exemption (folded while protected AND
	 * not-yet-sent). `healProtected` skips these: the model never saw them whole, so the tail
	 * growing over them yanks nothing. A strategy fold of a non-birth (sent / never-protected)
	 * block is NOT here, so it heals when the tail grows over it, exactly as a human fold does.
	 */
	private birthFolded = new Set<string>();
	/**
	 * Ids of surviving blocks that were ALREADY sent whole but a divergence rebuild pushed ABOVE the
	 * scalar `sentThroughOrder` frontier — a fresh block inserted BEFORE them drags the frontier back
	 * (the frontier is a prefix by `order`, so ONE early unsent block reclassifies every later block
	 * never-sent). Without this set a rebuild makes blocks the model already saw whole look fresh
	 * again: birth-fold-eligible, re-listed in `freshIds`. The effective "is this block sent?"
	 * predicate (`sent`) is therefore the UNION `(order <= sentThroughOrder) OR (id in carriedSent)`.
	 * Populated only by `rebuildFrom`; rides the snapshot so replicas agree (v15).
	 */
	private carriedSent = new Set<string>();

	/** Monotonic; bumps on every state change. Every event carries the post-change value. */
	private revCounter = 0;
	/** Per block/group id → the rev at which it last changed (for `baseRev` stale detection). */
	private lastChangedRev = new Map<string, number>();

	private index = new Map<string, number>();
	private listeners = new Set<(e: TruthEvent) => void>();

	// ── rev-keyed read caches (recomputed lazily when rev changes) ───────────
	private pfiCache = { rev: -1, value: 0 };
	private groupWireCache = { rev: -1, map: new Map<string, { tokens: number; collapsed: boolean }>() };
	/** `degradedRunKeys()`'s memo — see that method's doc comment. */
	private degradeCache = { rev: -1, keys: new Set<string>() };

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blockLog = parsed.blocks.slice();
		this.reindex();
		// Bulk-loaded (non-live) sessions were already part of a completed conversation — none of
		// their blocks is "fresh", so a strategy can never birth-fold history (ADR 0018 §5). A LIVE
		// session constructs EMPTY and streams blocks in, so the cursor starts at -1.
		this.sentThroughOrderValue = this.blockLog.length ? this.blockLog[this.blockLog.length - 1].order : -1;
	}

	private reindex(): void {
		this.index.clear();
		for (let i = 0; i < this.blockLog.length; i++) this.index.set(this.blockLog[i].id, i);
	}

	/**
	 * Phase B replica hydration. Overwrite this Truth's ENTIRE state from a serialized host
	 * snapshot and PIN `rev` to the host's, emitting NOTHING (the caller re-seeds its mirror).
	 * The GUI builds a replica Truth this way so replayed events stay rev-aligned with the
	 * authoritative extension-side Truth: after adopting, `rev === snapshot.rev`, and each
	 * subsequent replayed input bumps rev in lockstep — a mismatch after replay ⇒ resnapshot.
	 * `blocks` arrive with overlay already applied; groups/locks/config/sent/`birthFolded`/
	 * `carriedSent` are set verbatim — `birthFolded` MUST round-trip (v12) or `healProtected`
	 * diverges from the host: a replica that lost the set heals a block on its next housekeep that
	 * the host still keeps folded, and both sides bump `rev` by exactly one, so the mismatch is
	 * otherwise invisible. `carriedSent` MUST round-trip (v15) for the same silent-divergence reason:
	 * a replica that lost it reclassifies a block the host recorded as already-sent back to fresh
	 * (birth-fold-eligible / re-listed in `freshIds`), again with both revs still advancing in step.
	 * `calibration` (v18) now FEEDS DECISION MATH (stage 2, see the field's own doc comment) — a
	 * replica that lost it falls back to the safe default (1), which is a decision-affecting
	 * divergence in principle (a different `protectedFromIndex()`/`stats()` reading than the host's);
	 * in practice this can only happen via a stale/test literal omitting the field, never a real
	 * replica (the host serializer always emits it, and a replica that ever legitimately lost track
	 * would already have mismatched `rev` on the very next event and resnapshotted before the
	 * divergence could matter).
	 */
	adoptSnapshot(s: {
		blocks: Block[];
		groups: Group[];
		budget: number;
		contextWindow: number | null;
		protectTokens: number;
		locks: readonly LockName[];
		lockHolder: string | null;
		tailTokens: number;
		sentThroughOrder: number;
		wireAttached: boolean;
		birthFolded: readonly string[];
		carriedSent: readonly string[];
		calibration: number;
		rev: number;
	}): void {
		this.blockLog = s.blocks.slice();
		this.reindex();
		this.groupList = s.groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() }));
		this.budgetTok = s.budget;
		this.contextWindowTok = s.contextWindow;
		this.protectTokensTarget = s.protectTokens;
		this.activeLocks = s.locks.slice();
		this.holderLabel = s.lockHolder;
		this.activeTailTok = s.tailTokens;
		this.wireAttachedFlag = s.wireAttached;
		this.sentThroughOrderValue = s.sentThroughOrder;
		this.birthFolded = new Set(s.birthFolded);
		this.carriedSent = new Set(s.carriedSent);
		this.calibrationMul = Number.isFinite(s.calibration) && s.calibration > 0 ? s.calibration : 1;
		this.lastChangedRev.clear();
		this.revCounter = s.rev;
		// Rev-keyed read caches are stamped stale so they recompute against the adopted rev.
		this.pfiCache = { rev: -1, value: 0 };
		this.groupWireCache = { rev: -1, map: new Map<string, { tokens: number; collapsed: boolean }>() };
		this.degradeCache = { rev: -1, keys: new Set<string>() };
	}

	/**
	 * Structural-DIVERGENCE rebuild (tree-nav / compaction / another extension rewriting
	 * `event.messages`): build a fresh Truth from `parsed`'s blocks, then carry over `prev`'s
	 * per-block overlay, `birthFolded` membership, scalar dials, and any group whose members ALL
	 * survive. An id absent from the fresh block log has nothing to carry — it no longer exists.
	 * `prev === null` (the very first build of a session) skips carryover entirely: there is
	 * nothing yet to preserve, and a brand-new session must never inherit a PRIOR session's state.
	 *
	 * This is the fix for the review finding that a divergence rebuild used to construct a bare
	 * `new Truth(...)` and silently drop every human/host fold, pin, group, and dial — including
	 * for block ids that survived the rebuild untouched. `contextWindow` is deliberately NOT
	 * carried: it is a live fact re-derived from the current model, not a preserved dial (the
	 * extension re-applies it right after calling this, same as any other build).
	 *
	 * Housekeeping runs once at the end so the freshly-carried overlay/groups can't leave the
	 * result in a state that violates the protected-tail invariant (the new block log's tail
	 * boundary may differ from `prev`'s).
	 */
	static rebuildFrom(prev: Truth | null, parsed: ParsedSession): Truth {
		const next = new Truth(parsed);
		if (!prev) return next;
		next.budgetTok = prev.budgetTok;
		next.protectTokensTarget = prev.protectTokensTarget;
		next.activeLocks = prev.activeLocks.slice();
		next.holderLabel = prev.holderLabel;
		next.activeTailTok = prev.activeTailTok;
		next.calibrationMul = prev.calibrationMul;
		for (const b of next.blockLog) {
			const old = prev.get(b.id);
			if (!old) continue;
			b.override = old.override;
			b.autoFolded = old.autoFolded;
			b.by = old.by;
			// A same-id CONTENT rewrite (pi replaced this block's text under a stable id — the E1
			// fingerprint-divergence path) makes the carried `subst` a summary of the OLD text, so the
			// wire would keep emitting a stale digest. Drop it on a text change; a strategy fold keeps
			// `autoFolded` and re-digests from the fresh text (the engine per-kind digest recomputes) —
			// only the custom replace-`subst` is discarded, never the fold itself.
			b.subst = b.text === old.text ? old.subst : undefined;
			if (prev.birthFolded.has(b.id)) next.birthFolded.add(b.id);
		}
		// Carry the SENT FRONTIER. `new Truth(parsed)` marked every block sent (bulk-born, ADR 0018
		// §5); that is wrong for a live rebuild — a block that was UNSENT in `prev` (a fresh
		// tool_result mid-turn) or is genuinely NEW must stay unsent, or the rebuild silently kills
		// its birth-fold eligibility (canFold's `!sent(b)` branch). A surviving block keeps prev's
		// sent-state; a new block is unsent. Sent-ness is a prefix by `order`, so the frontier lands
		// just before the earliest not-sent block regardless of the log's array order.
		let frontier = next.blockLog.length ? next.blockLog[next.blockLog.length - 1].order : -1;
		for (const b of next.blockLog) {
			const old = prev.get(b.id);
			const wasSent = old ? prev.sent(old) : false;
			if (!wasSent) frontier = Math.min(frontier, b.order - 1);
		}
		next.sentThroughOrderValue = frontier;
		// A surviving block that WAS sent (per prev's UNION predicate) but now sits ABOVE the frontier
		// — a freshly-inserted-earlier UNSENT block dragged the `order`-prefix frontier back before it
		// — would be silently reclassified never-sent by the scalar alone. Carry those ids so `sent`
		// stays true for them: the model already saw them whole, so they must NOT become birth-fold-
		// eligible or re-enter `freshIds`. `prev.sent` is the union, so a prev-carried id re-carries —
		// the set is transitive across successive rebuilds. Only blocks above the frontier are carried
		// (below it the scalar already covers them), keeping the set — and the snapshot — minimal.
		for (const b of next.blockLog) {
			if (b.order <= frontier) continue;
			const old = prev.get(b.id);
			if (old && prev.sent(old)) next.carriedSent.add(b.id);
		}
		const survivors = next.index;
		next.groupList = prev.groupList
			.filter((g) => {
				if (!g.memberIds.every((id) => survivors.has(id))) return false; // a member vanished
				// A carried group must still be CONTIGUOUS in the new order. The wire emits one summary
				// per contiguous run (`applyPlan`), while group accounting charges one summary for the
				// whole group — if a rebuild reordered the surviving members apart, keeping the group
				// would fork accounting from the wire. Drop it (don't re-snap); surviving members keep
				// their own per-block overlay, they just no longer share a group.
				const idxs = g.memberIds.map((id) => survivors.get(id)!).sort((a, b) => a - b);
				return idxs.every((v, k) => k === 0 || v === idxs[k - 1] + 1);
			})
			// Re-derive `memberIds` in the NEW block order: a rebuild can keep a group CONTIGUOUS while
			// reordering its members, and `memberIds` is documented "in conversation order" (the wire's
			// per-run summary emission and `classifyGroup`'s run detection both iterate it in order).
			// Sort surviving members by their new index to restore that invariant; the group's `id`
			// stays its original handle (an opaque `foldCode` anchor, not re-derived from members).
			.map((g) => ({ ...g, memberIds: g.memberIds.slice().sort((a, b) => survivors.get(a)! - survivors.get(b)!) }));
		next.housekeep(new Set<string>());
		return next;
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
	/** The current provider-anchored calibration multiplier (default 1). See `calibrationMul`'s doc. */
	get calibration(): number {
		return this.calibrationMul;
	}
	/**
	 * Calibrated value of a raw token estimate — `Math.round(n * calibration)`. A pure helper a
	 * caller routes a number it ALREADY computed (`liveTokens()`, `effTokens(b)`, a per-kind sum, …)
	 * through to opt into calibration. Stage 1 (issue #11, ADR 0025) used this for DISPLAY only;
	 * stage 2 additionally routes it through `stats()` (so `TruthStats.liveTokens`/`fullTokens` are
	 * calibrated) and through the conductor-facing `ViewBlock.tokens`/`foldedTokens`
	 * (`core/conductor/hostAdapter.ts`'s `viewBlockOf`) and `ConductorHost.countTokens` — see the
	 * "convention" note on `TruthStats` for why calibrating every conductor read surface (rather than
	 * leaving per-block reads raw) is the coherent choice. `protectedFromIndex()` does NOT call this
	 * helper — it converts the TARGET into raw-estimate space with one division instead (see that
	 * method's doc for why). One multiplier necessarily SMEARS the fixed system-prompt/tool-schema
	 * overhead (which belongs to no block) proportionally across every block rather than carrying it
	 * as its own line item — `real = base + k·est` would be the honest affine model; this ships the
	 * pure multiplier knowingly (ADR 0025's Deferred section).
	 */
	calTokens(n: number): number {
		return Math.round(n * this.calibrationMul);
	}
	get locks(): readonly LockName[] {
		return this.activeLocks;
	}
	get lockHolder(): string | null {
		return this.activeLocks.length ? this.holderLabel : null;
	}
	/** Ids currently birth-folded (see `birthFolded` above). A snapshot must carry this verbatim. */
	get birthFoldedIds(): readonly string[] {
		return [...this.birthFolded];
	}
	/** Ids in the carried-sent set (see `carriedSent`). A snapshot must carry this verbatim (v15). */
	get carriedSentIds(): readonly string[] {
		return [...this.carriedSent];
	}
	/** The tail target the holder enforces while holding `tail-size` (0 when not held). */
	get activeTailTokens(): number {
		return this.isLocked("tail-size") ? this.activeTailTok : 0;
	}
	isLocked(name: LockName): boolean {
		return hasLock(this.activeLocks, name);
	}

	/** The highest block `order` whose content has reached the model (serialized wire). The scalar
	 *  frontier ONLY — `carriedSent` (a rebuild's per-id preserved sent-ness) is separate; use
	 *  `sent(b)`/`isSent(id)` for the effective predicate. */
	get sentThroughOrder(): number {
		return this.sentThroughOrderValue;
	}
	/**
	 * Has this block's content reached the model in an applied plan? The UNION of the scalar
	 * `order`-prefix frontier and the per-id `carriedSent` set a divergence rebuild preserves (see
	 * `carriedSent`) — so a block the model saw whole stays "sent" even after a fresh earlier block
	 * drags the frontier back below it. Every consumer of sent-ness (birth-fold eligibility,
	 * `canFold`'s wire guard, the host adapter's `freshIds`) reads this predicate, so they all agree.
	 */
	sent(b: Block): boolean {
		return b.order <= this.sentThroughOrderValue || this.carriedSent.has(b.id);
	}
	/** Id form of `sent` — for a caller holding an id but not the `Block` (the extension ingress
	 *  will switch to this). Unknown id ⇒ false (a block we don't hold was never sent from here). */
	isSent(id: string): boolean {
		const b = this.get(id);
		return b ? this.sent(b) : false;
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
		// Calibrate the AGGREGATE once (a single `calTokens` call per field), never per-block inside
		// `liveTokens()`/`fullTokens()` themselves — those stay the raw accessors every other internal
		// caller (`effTokens`, group accounting, `serializeWire`) still needs untouched. See
		// `TruthStats`'s doc for the "calibrate every conductor read surface" convention this
		// implements alongside `viewBlockOf`/`countTokens`.
		return {
			rev: this.revCounter,
			liveTokens: this.calTokens(this.liveTokens()),
			fullTokens: this.calTokens(this.fullTokens()),
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
		// With a live wire attached, a positional (non-durable) id can't be folded: `computeFoldOps`
		// drops it, so the model would still receive full content while the UI/accounting show it
		// folded. Refuse it here rather than fork the two. Non-wire (demo/CC/file) sessions have no
		// wire to diverge from, so this gate is wire-conditional — same rule as group accounting.
		if (this.wireAttached && !isDurableId(b.id)) return false;
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
	/**
	 * The first block index inside the protected working tail. Issue #11 stage 2 (ADR 0025):
	 * `protectTokens` (and a `tail-size` holder's enforced `activeTailTokens`) is the USER-MEANINGFUL
	 * dial — sized in REAL tokens — so the walk below must size the tail against a CALIBRATED
	 * reading of the block log, not the raw chars/4 sum it used to compare against directly.
	 *
	 * See `computeProtectedFromIndex` for the exact mechanism (one division of the target, not a
	 * `calTokens` multiplication per block) and why that choice is the deterministic one across a
	 * host/replica pair.
	 */
	protectedFromIndex(): number {
		if (this.pfiCache.rev === this.revCounter) return this.pfiCache.value;
		const value = this.computeProtectedFromIndex();
		this.pfiCache = { rev: this.revCounter, value };
		return value;
	}
	private computeProtectedFromIndex(): number {
		const blocks = this.blockLog;
		if (!blocks.length) return 0;
		const targetReal = this.isLocked("tail-size") ? this.activeTailTok : this.protectTokensTarget;
		if (targetReal === 0) return blocks.length;
		// Convert the REAL-token target into the EQUIVALENT raw-estimate threshold by ONE division,
		// rather than calibrating (multiplying) each block's raw `tokens` inside the walk below.
		// `calibrated(rawSum) >= targetReal` iff `rawSum >= targetReal / calibration`, so the two
		// forms are mathematically identical — but a SINGLE shared division is the deterministic one
		// across a host/replica pair. `calibrationMul` is a rev-stamped scalar both sides carry
		// byte-identical (replicated verbatim over the wire, JSON round-trips a float64 exactly), so
		// one division from the same two operands produces a bit-identical result on both sides
		// (IEEE-754 basic ops are deterministic). Calibrating per block instead would call
		// `Math.round` (inside `calTokens`) once per iteration — its cumulative rounding error is a
		// function of iteration order and count, which a host and a replica have no contractual
		// guarantee to walk identically over time (a replica may resnapshot mid-walk-history,
		// reorder-free but not iteration-for-iteration-identical against every historical host pass).
		// A single division has no such accumulation to diverge on.
		const target = targetReal / this.calibrationMul;
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
		let n = 0;
		for (const run of c.collapsedRuns) n += this.runWireTok(g, c, run);
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
			const runTok = new Map<string, number>(); // carrier (run[0]) id → THIS run's own wire cost
			for (const run of c.collapsedRuns) runTok.set(run[0].id, this.runWireTok(g, c, run));
			for (const b of c.members) {
				if (c.collapsed.has(b.id)) m.set(b.id, { tokens: runTok.get(b.id) ?? 0, collapsed: true });
				else m.set(b.id, { tokens: b.tokens, collapsed: false });
			}
		}
		this.groupWireCache = { rev: this.revCounter, map: m };
		return m;
	}
	/**
	 * The wire cost of ONE collapsed run within a folded group. A REPLACE group (`g.digest` a
	 * string, or `undefined` → auto-recap) inserts the SAME summary text for every run of that
	 * group (`applyPlan`'s Phase B reuses `g.summaryText`/the auto-digest verbatim per run — see
	 * the "INTERIOR straggler (TWO runs)" cross-validation test), so charging every run the same
	 * scalar is correct and unchanged from before.
	 *
	 * A DROP group (`isDropGroup`) is NOT uniform across runs: `applyPlan`'s role-validity floor
	 * (ADR 0006's open watch item, closed by `computeDegradedDropRuns`) can independently degrade
	 * ONE run of a drop group to a one-message recap while its siblings still vanish for free — a
	 * single "0 for every run" shortcut would under-count a degraded run's real cost and make the
	 * GUI's savings readout LIE about what the model actually receives (the one thing this repo
	 * promises never happens). `degradedRunKeys()` re-derives the EXACT same verdict `applyPlan`
	 * would reach for this run — via the SAME exported `computeDegradedDropRuns` function, not a
	 * parallel re-implementation of the role-adjacency check — so this can never silently drift
	 * from the wire. A degraded run's cost is the recap's OWN token estimate, built from the exact
	 * SAME text `applyPlan` synthesizes (`roleFloorRecap`, exported from `wire.ts` for this reason)
	 * so the number matches token-for-token, not just in shape.
	 */
	private runWireTok(g: Group, c: GroupShape, run: Block[]): number {
		if (!c.carrier) return 0;
		if (this.isDropGroup(g)) {
			if (!this.degradedRunKeys().has(messageKey(run[0].id))) return 0;
			return estTokens(roleFloorRecap(g.id, messageCountOfRun(run))) + BLOCK_OVERHEAD;
		}
		if (typeof g.digest === "string" && g.digest) return estTokens(g.digest) + BLOCK_OVERHEAD;
		return groupDigestTokens(g, c.collapsedMembers);
	}

	/**
	 * Which collapsed runs (identified by their carrier block's `messageKey`) `applyPlan`'s
	 * role-validity floor would degrade to a recap RIGHT NOW, across every folded group at once —
	 * memoized per `rev` (like `groupWire`/`protectedFromIndex`) since every group's accounting
	 * reads it.
	 *
	 * WHY this must call the wire's OWN function and never a re-derived approximation: the floor's
	 * verdict for one run depends on global context — which OTHER runs (this group's or another
	 * group's) survive, degrade, or vanish right next to it — exactly the cross-run cascade
	 * `computeDegradedDropRuns` already implements for `applyPlan`. Re-deriving an "equivalent"
	 * check here would inevitably diverge on some edge case (a second folded group nearby, a
	 * cascaded chain of drops), and drift between the wire and the accounting is precisely the bug
	 * this method exists to close — the UI's claimed savings would once again lie about what the
	 * model actually received. Calling the SAME function makes drift structurally impossible: same
	 * inputs in, same verdict out, whether that function runs inside `applyPlan` (host, real
	 * `PiMessage[]`) or here (host OR replica, reconstructed from `Block`s).
	 *
	 * `Truth` never holds pi's real messages (only the extension does, and only transiently, as
	 * `serializeWire`'s parameter) — but a live `Block`'s own id already encodes which wire-role
	 * class produced it (`wireRoleOfId`, the inverse of `blockId`'s prefix scheme), so the needed
	 * `WireMsgShape[]` is reconstructed from `blockLog` alone (`buildWireShapes`), same for the
	 * host and a replica that only ever adopted a snapshot.
	 *
	 * PERFORMANCE: one O(blockCount) pass to reconstruct `WireMsgShape[]` plus `computeGroupOps()`
	 * (O(foldedGroups), already paid by `serializeWire` on the host) — no worse an order than the
	 * O(blockCount) `liveTokens()`/`fullTokens()` passes this same rev change already triggers, and
	 * skipped entirely (no reconstruction at all) when no group is folded.
	 */
	private degradedRunKeys(): Set<string> {
		if (this.degradeCache.rev === this.revCounter) return this.degradeCache.keys;
		const groups = this.computeGroupOps();
		const keys = new Set<string>();
		if (groups.length) {
			const { shapes, keys: msgKeys } = this.buildWireShapes();
			const { degradeStart } = computeDegradedDropRuns(shapes, groups);
			for (const idx of degradeStart) keys.add(msgKeys[idx]);
		}
		this.degradeCache = { rev: this.revCounter, keys };
		return keys;
	}
	/** Reconstruct one `WireMsgShape` per logical message in `blockLog`, grouped by `messageKey`
	 *  (blocks sharing a key are always contiguous — see `messageCountOfRun`) — the `Block`-only
	 *  equivalent of `messages.map((m,i) => ({...messageInfo(m,i), role: m.role}))`, which is all
	 *  `applyPlan` itself builds from real `PiMessage[]` before calling `computeDegradedDropRuns`. */
	private buildWireShapes(): { shapes: WireMsgShape[]; keys: string[] } {
		const shapes: WireMsgShape[] = [];
		const keys: string[] = [];
		let curKey: string | null = null;
		let ids: string[] = [];
		let calls: string[] = [];
		let results: string[] = [];
		let hasNonDurable = false;
		const flush = () => {
			if (curKey === null) return;
			shapes.push({ role: wireRoleOfId(ids[0]), ids, calls, results, hasNonDurable });
			keys.push(curKey);
		};
		for (const b of this.blockLog) {
			const k = messageKey(b.id);
			if (k !== curKey) {
				flush();
				curKey = k;
				ids = [];
				calls = [];
				results = [];
				hasNonDurable = false;
			}
			ids.push(b.id);
			if (!isDurableId(b.id)) hasNonDurable = true;
			if (b.callId) {
				if (b.kind === "tool_call") calls.push(b.callId);
				else if (b.kind === "tool_result") results.push(b.callId);
			}
		}
		flush();
		return { shapes, keys };
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
		// Refuse non-finite input rather than poison the dial: NaN survives `Math.max`/`Math.round`
		// (`Math.max(1000, NaN) === NaN`), then JSON serializes NaN/Infinity as `null` on the wire —
		// forking every replica. A malformed value is a no-op (no rev bump, no event), not a fork.
		if (!Number.isFinite(n)) return;
		this.budgetTok = Math.max(1000, Math.round(n));
		const touched = new Set<string>();
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		this.emit({ type: "config", budget: this.budgetTok, rev });
	}
	setContextWindow(n: number): void {
		if (!Number.isFinite(n)) return; // same non-finite refusal as setBudget — a NaN would fork replicas via JSON null
		this.contextWindowTok = n;
		const rev = ++this.revCounter;
		this.emit({ type: "config", contextWindow: this.contextWindowTok, rev });
	}
	setProtect(n: number): void {
		// The human can no longer resize the tail under the `tail-size` lock (the holder owns it).
		if (this.isLocked("tail-size")) return;
		if (!Number.isFinite(n)) return; // refuse NaN/Infinity — poisons the protected-tail dial + forks replicas
		this.protectTokensTarget = Math.max(0, Math.round(n));
		const touched = new Set<string>();
		this.housekeep(touched);
		const rev = ++this.revCounter;
		for (const id of touched) this.lastChangedRev.set(id, rev);
		this.emit({ type: "config", protectTokens: this.protectTokensTarget, rev });
	}
	/**
	 * HOST-ONLY calibration snap (issue #11 stage 1, ADR 0025): `k = realTokens / estWireTokens` for
	 * the request that just completed. Raw snap, no clamp, no smoothing/EMA — owner-approved v1
	 * policy: the dial always reflects the MOST RECENT observation, not a running average. There is
	 * no `WireCommand` kind for this — a client can never call it; only the extension's own host code
	 * does, after pairing an assistant message's real usage against the estimate of the wire that
	 * produced it (see `extension/accordion.ts`'s `maybeObserveCalibration`). A non-finite or
	 * non-positive `k` is refused (poisons the dial / forks replicas via JSON `null`), the same guard
	 * shape as `setBudget`/`setProtect`.
	 */
	setCalibration(k: number): void {
		if (!Number.isFinite(k) || k <= 0) return;
		this.calibrationMul = k;
		const rev = ++this.revCounter;
		this.emit({ type: "config", calibration: this.calibrationMul, rev });
	}
	markSent(order: number): void {
		if (order <= this.sentThroughOrderValue) return;
		this.sentThroughOrderValue = order;
		const rev = ++this.revCounter;
		this.emit({ type: "sent", throughOrder: this.sentThroughOrderValue, rev });
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
	/**
	 * Release the involvement locks. `inheritTail` (the conductor-detach path) closes the
	 * freeze-safety hole: a `tail-size` conductor enforces a small (often zero) tail while it holds
	 * the session; on plain detach `protectTokens` snaps BACK to the human's larger dial, and the
	 * very next housekeep then prunes the (freeze-converted, human-owned) whole-session group and
	 * heals the frozen folds — destroying exactly the work `freeze` promised to preserve. With
	 * `inheritTail:true`, the enforced tail is adopted as `protectTokens` BEFORE the lock releases,
	 * so the protected boundary does NOT snap back; the human regains the dial and re-expanding it
	 * later is their own conscious act (normal healing then applies, and F3 makes that heal
	 * complete). Plain `clearLocks()` keeps the legacy snap-back behavior.
	 *
	 * No protocol change: `protectTokens` already rides `config` events, so the inherited value is
	 * emitted as one — a replica that later resnapshots (the config lands while its own `tail-size`
	 * lock is momentarily still set) recovers the inherited value from the fresh snapshot. The
	 * config event fires FIRST so any divergence surfaces as a rev mismatch (⇒ resnapshot), never a
	 * silent state fork. Wave 2 wires `LiveConductorHost.detachActive` to pass `{inheritTail:true}`.
	 */
	clearLocks(opts?: { inheritTail?: boolean }): void {
		const inheritedTail = opts?.inheritTail && this.isLocked("tail-size") ? this.activeTailTok : null;
		this.activeLocks = [];
		this.holderLabel = null;
		this.activeTailTok = 0;
		if (inheritedTail !== null) {
			this.protectTokensTarget = inheritedTail;
			const crev = ++this.revCounter;
			this.emit({ type: "config", protectTokens: this.protectTokensTarget, rev: crev });
		}
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
	 * Engine invariant — protection is absolute for the human. Heal a HUMAN fold the tail has grown
	 * over, and a STRATEGY fold of a block the model already saw whole, in ONE coherent pass that
	 * clears EVERY fold field so nothing half-heals.
	 *
	 * Never touched:
	 *   - a PIN (`override === "pinned"`) — protection never revokes a hard pin, and clearing `by`
	 *     underneath it would corrupt the pin's provenance;
	 *   - a sticky UNFOLD (`override === "unfolded"`) — a human/agent decision to hold the block open
	 *     (ADR 0005) is not a fold to heal, and it is already live;
	 *   - a BIRTH-FOLD (strategy fold applied while protected AND unsent) — the model never saw it
	 *     whole, so the tail growing over it yanks nothing.
	 *
	 * Everything else that is folded — a human fold (`override:"folded"`), a strategy fold
	 * (`autoFolded`), a `replace` subst, OR a freeze-converted fold (which is `override:"folded"`
	 * AND `autoFolded` AND carries a `subst`) — is fully reset in the single branch below. The old
	 * two-branch shape left a frozen fold half-healed (cleared the override but left `autoFolded`/
	 * `subst`, so `isFolded` stayed true) and could zero a pin's `by`; this pass fixes both.
	 */
	private healProtected(touched: Set<string>): void {
		const pf = this.protectedFromIndexUncached();
		for (let i = pf; i < this.blockLog.length; i++) {
			const b = this.blockLog[i];
			if (b.override === "pinned" || b.override === "unfolded") continue;
			if (this.birthFolded.has(b.id)) continue;
			if (b.override === "folded" || b.autoFolded || b.subst !== undefined) {
				b.override = null;
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
			case "freeze":
				return this.opFreeze(op, touched);
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

	// Multi-id ops fold their per-id outcome into one result (applied iff ANY id applied). The batch
	// `applied`/`clamped` stay what existing callers read; `perId` records EACH id's outcome so the
	// replica-facing event can forward only the ids that actually applied (see the `perId` doc in
	// ops.ts and `wireEventFromTruthEvent`) — a per-id clamp must never replay on a baseRev-less
	// replica and diverge it while both revs still advance in lockstep.
	private eachId(op: Op & { ids: string[] }, touched: Set<string>, fn: (id: string) => ClampReason | null): OpResult {
		const perId: { id: string; applied: boolean; reason?: ClampReason }[] = [];
		let applied = false;
		let lastClamp: ClampReason | undefined;
		for (const id of op.ids) {
			const c = fn(id);
			if (c === null) {
				applied = true;
				touched.add(id);
				perId.push({ id, applied: true });
			} else {
				lastClamp = c;
				perId.push({ id, applied: false, reason: c });
			}
		}
		return applied ? { op, applied: true, perId } : { op, applied: false, clamped: lastClamp ?? "noop", perId };
	}

	private opFold(op: Extract<Op, { kind: "fold" }>, by: Actor, baseRev: number | undefined, touched: Set<string>): OpResult {
		if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
		return this.eachId(op, touched, (id) => {
			const b = this.get(id);
			if (!b) return "unknown-id";
			if (this.stale(id, baseRev)) return "stale";
			if (this.inFoldedGroup(id)) return "grouped";
			if (!wireFoldable(b)) return "not-foldable";
			if (this.wireAttached && !isDurableId(id)) return "non-durable"; // wire would silently drop it
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
		if (this.wireAttached && !isDurableId(op.id)) return this.clamp(op, "non-durable"); // wire would silently drop it
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
			if (by === "auto") {
				// A STRATEGY unfold behaves exactly like `auto`: clear the strategy's own fold with
				// NO standing override (see the `unfold` Op doc in ops.ts). Writing an `unfolded`
				// override here would wedge the strategy out of its own block — `canFold`/`opAuto`
				// both refuse a non-null override, so it could never re-fold what it just opened.
				if (b.override !== null) return "human-override"; // a human override wins
				if (!b.autoFolded && b.subst === undefined) return "noop";
				b.autoFolded = false;
				b.subst = undefined;
				b.by = null;
				this.birthFolded.delete(id);
				return null;
			}
			// human unfold — hold the block open (a sticky `unfolded` override)
			b.override = "unfolded";
			b.by = "you";
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

	/**
	 * Conductor-detach kill switch. Mirrors `opReset`'s shape (a single global op, no ids, no
	 * `by`/lock gate, one aggregate `OpResult`) but transfers ownership instead of clearing it:
	 * every strategy-owned fold becomes human-owned with `subst` preserved verbatim, and every
	 * folded strategy group is reassigned to "you". Deliberately does NOT check
	 * `isLocked("human-steering")` — see the `freeze` Op doc in ops.ts.
	 */
	private opFreeze(op: Extract<Op, { kind: "freeze" }>, touched: Set<string>): OpResult {
		let changed = false;
		for (const b of this.blockLog) {
			if (b.override === null && b.autoFolded && !this.inFoldedGroup(b.id)) {
				b.override = "folded";
				b.by = "you";
				// `subst` is deliberately left untouched — the strategy's substituted digest
				// must survive the ownership transfer byte-identical.
				touched.add(b.id);
				changed = true;
			}
		}
		let groupsChanged = false;
		for (const g of this.groupList) {
			if (g.folded && g.by === "auto") {
				g.by = "you";
				touched.add(g.id);
				changed = true;
				groupsChanged = true;
			}
		}
		if (groupsChanged) this.groupList = [...this.groupList];
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

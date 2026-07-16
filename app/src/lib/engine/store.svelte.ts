/*
 * store.svelte.ts — the accordion model.
 *
 * Owns every block's fold state and the group/protected-tail machinery. This is the
 * single source of truth; the UI only renders it and calls its actions. Folding is
 * content substitution, never removal: a folded block still exists and still carries
 * its callId, so a tool_call/result pair is never structurally broken.
 *
 * NOTE: the conductor strategy layer was removed on this branch pending a ground-up
 * redesign (see CLAUDE.md). There is currently NO automatic folder — budget pressure
 * no longer folds anything on its own. The engine keeps only human-driven folds/pins,
 * multiblock groups, the protected working tail, digests, and the agent unfold/recall
 * provenance. `refold()` is now pure housekeeping (protected-tail healing + group
 * pruning). The `autoFolded` field and the `"auto"` actor are kept as dormant plumbing
 * for the reintroduced auto-folder.
 */
import type { Block, Actor, SessionMeta, ParsedSession, Group } from "./types";
import type { LockName } from "./locks";
import { hasLock } from "./locks";
import { digest, digestTokens, groupDigest, groupDigestTokens, wireFoldable } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";
import { isDurableId } from "../live/mapping";

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
	/**
	 * The collapsed members split into maximal contiguous RUNS (in member/conversation order),
	 * each run uninterrupted by a straggler. The wire inserts ONE summary message per run, so the
	 * VIEW must charge one summary cost per run too (ADR 0006 §5 — see `groupWire`/`groupLiveTokens`).
	 * The first block of each run "carries" that run's summary cost; the rest carry 0.
	 */
	collapsedRuns: Block[][];
}

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
	 * NEVER folded, with a strict 25% whole-block overflow cap so a huge boundary
	 * block cannot silently double the protected region. When target > 0, the newest block
	 * is always protected even if it alone exceeds the cap. When target === 0, protection
	 * is fully disabled — all blocks are foldable. Protection is absolute: manual folds are
	 * refused there too.
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
	 * True iff a live pi WIRE is attached (the live client sets this to true on connect and
	 * false on disconnect). This is the precise "a wire is involved" signal for the
	 * view-mirrors-wire invariant (issue #13): only in a live session does `classifyGroup`
	 * enforce durability-aware accounting (non-durable-id members stay live, splitting the
	 * collapsed run — exactly what the wire's `applyPlan` does). Demo / loaded sessions leave
	 * this false → durability-AGNOSTIC collapse (the GUI shows the logical grouping, which the
	 * issue explicitly permits whenever "no wire is involved").
	 */
	wireAttached = false;

	// ---- involvement locks (ADR 0011) -------------------------------------
	/**
	 * Reactive snapshot of the currently-held lock-set (ADR 0011). Empty ⇒ collaborative —
	 * every gate below is byte-for-byte the human-operated engine's behavior. A non-empty set
	 * ⇒ exclusive: the named human/agent controls are refused and (under `tail-size`) the
	 * protected tail is driven by `activeTailTokens` instead of `protectTokens`.
	 *
	 * NOTHING holds a lock today except the programmatic API (`setLocks`/`clearLocks`) driven
	 * by tests and the future conductor host — there is no conductor object. The engine's
	 * per-action gates read this snapshot; because `setLocks` writes it synchronously before
	 * the `refold()` it triggers, enforcement is exact.
	 */
	private activeLocks = $state<readonly LockName[]>([]);
	/**
	 * The tail target the holder wants while holding `tail-size` (ADR 0011 §7). Semantics
	 * parallel the human's `protectTokens`: 0 ⇒ own the whole context (no protected tail);
	 * `N > 0` ⇒ protect the newest ~N tokens. Always 0 when `tail-size` is not held. Clamped
	 * to a finite, non-negative integer in `setLocks` so a buggy caller can never poison the
	 * boundary or leak a non-finite value.
	 */
	private activeTailTokens = $state(0);
	/** Label of whoever set the current lock-set (for UI tooltips); null while collaborative. */
	private holder = $state<string | null>(null);

	/** Does the current lock-set hold `name`? PUBLIC — the UI gates affordances/tooltips on it. */
	isLocked(name: LockName): boolean {
		return hasLock(this.activeLocks, name);
	}
	/** The effective lock-set, as a reactive read for the UI. Empty ⇒ collaborative. */
	get locks(): readonly LockName[] {
		return this.activeLocks;
	}
	/** Label of whoever holds the current locks (for UI tooltips), or null if collaborative. */
	get lockHolder(): string | null {
		return this.activeLocks.length ? this.holder : null;
	}
	/** A HUMAN action is locked out iff it is the human's AND `human-steering` is held. */
	private humanLocked(by: Actor): boolean {
		return by === "you" && this.isLocked("human-steering");
	}

	/**
	 * Set the active lock-set (ADR 0011). PUBLIC — the programmatic seam for the future
	 * conductor host (and tests); no conductor object is involved.
	 *
	 * Consent-time semantics (ADR 0011 §6): acquiring a lock releases existing overrides in the
	 * now-locked domain so the holder authors from a clean baseline — `human-steering` releases
	 * every human override AND dissolves human-owned groups; `agent-unfold` releases the agent's
	 * sticky unfolds. `holder` labels who took the keys (surfaced in UI tooltips). `tailTokens`
	 * is honored only under the `tail-size` lock and is clamped to a finite non-negative integer.
	 */
	setLocks(locks: readonly LockName[], holder: string, tailTokens: number = 0): void {
		this.activeLocks = locks.slice();
		this.holder = holder;
		// Clamp defensively: a non-finite / negative tailTokens must collapse to 0
		// (own-the-whole-context), never poison `protectedFromIndex` or the boundary math.
		this.activeTailTokens = Number.isFinite(tailTokens) ? Math.max(0, Math.round(tailTokens)) : 0;
		// Release standing holds in the newly-locked domains BEFORE the refold reads them.
		this.releaseLockedDomains(this.activeLocks);
		this.refold();
	}
	/**
	 * Release every lock and restore human seniority (ADR 0011). PUBLIC — the programmatic seam
	 * for the future host's kill switch (and tests). Human/agent overrides that survived the
	 * lock stay as they are; the protect target simply falls back to `protectTokens` (the
	 * `tail-size` walk-back input reverts), and any fold the restored protected tail now covers
	 * heals back to live on the refold. This is NOT the freeze-on-detach flow — that view-
	 * preserving behavior returns with the conductor redesign's host.
	 */
	clearLocks(): void {
		this.activeLocks = [];
		this.holder = null;
		this.activeTailTokens = 0;
		this.refold();
	}

	/**
	 * ADR 0011 consent → baseline. Clear standing overrides in the domains the incoming lock-set
	 * claims: under `human-steering` every HUMAN override (pin / manual fold / manual unfold) AND
	 * every human-owned group is released; under `agent-unfold` every AGENT sticky unfold is
	 * released. No-op when the lock-set claims neither — so a collaborative set changes nothing.
	 *
	 * Human groups are part of the `human-steering` domain (a multiblock fold is human steering),
	 * so they are dissolved too — otherwise a stale human group would sit in the holder's field
	 * and `createGroup` (which refuses overlap with ANY existing group) would block the holder
	 * from authoring the very view the lock handed it. Legacy absent-`by` groups are treated as
	 * human here, the same as everywhere else; only explicit `by:"auto"` (dormant auto-grouping
	 * plumbing) is preserved.
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
			}
		}
		// Release human-owned (and legacy absent-`by`) groups so the holder authors from a clean
		// field. `by:"auto"` groups are dormant auto-grouping plumbing, not the human's to release.
		if (lockHuman && this.groups.length) {
			const kept = this.groups.filter((g) => g.by === "auto");
			if (kept.length !== this.groups.length) this.groups = kept;
		}
	}

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blocks = parsed.blocks;
		this.reindex();
		this.refold();
	}

	private reindex(): void {
		this.index.clear();
		for (let i = 0; i < this.blocks.length; i++) this.index.set(this.blocks[i].id, i);
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
		// Folded: the engine's per-kind digest (which carries the `{#code FOLDED}` recovery tag).
		return digestTokens(b);
	}
	/** What a folded block renders / the agent receives: the engine's per-kind digest
	 * (which carries the `{#code FOLDED}` recovery tag). */
	digestOf(b: Block): string {
		return digest(b);
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
			// The wire inserts ONE summary message PER contiguous collapsed run (applyPlan Phase B).
			// So the VIEW charges one summary cost to the FIRST block of EACH run; every other
			// collapsed member holds 0. The per-run summaries are byte-identical, so each costs the
			// same `summaryTok` (drop → 0, custom literal → its tokens, default recap → digest).
			const summaryTok = this.groupSummaryTok(g, c);
			const runFirsts = new Set(c.collapsedRuns.map((r) => r[0].id));
			for (const b of c.members) {
				if (c.collapsed.has(b.id)) m.set(b.id, { tokens: runFirsts.has(b.id) ? summaryTok : 0, collapsed: true });
				else m.set(b.id, { tokens: b.tokens, collapsed: false }); // straggler: live, full
			}
		}
		return m;
	});

	/**
	 * The token cost of ONE of a folded group's summary messages — drop group → 0, custom literal
	 * digest → its own token cost, default recap → `groupDigestTokens` over ALL collapsed members.
	 * The wire emits one such summary per contiguous run, all byte-identical, so each run costs this.
	 * Returns 0 when nothing collapses (no carrier). Shared by `groupWire` + `groupLiveTokens`.
	 */
	private groupSummaryTok(g: Group, c: GroupShape): number {
		if (!c.carrier) return 0;
		if (this.isDropGroup(g)) return 0; // drop group: no wire message inserted
		if (typeof g.digest === "string" && g.digest) return estTokens(g.digest) + BLOCK_OVERHEAD; // custom literal
		return groupDigestTokens(g, c.collapsedMembers); // default recap
	}

	/**
	 * Split a group's members into what collapses (whole, tool-pair-balanced messages →
	 * the one summary) vs. what stays live (a tool-pair half whose partner sits outside the
	 * group — the owner's "leave straggler live" rule). Pure.
	 *
	 * The removable set is the SAME MESSAGE-LEVEL FIXPOINT the wire runs in `applyPlan`'s
	 * Phase A (`mapping.ts`): start with every member message removable, then repeatedly demote
	 * any removable message that holds a tool_call whose callId is not among the removable set's
	 * results, OR a tool_result whose callId is not among the removable set's calls — until
	 * stable. A single pass is NOT enough: demoting one message can orphan a tool-pair partner in
	 * another still-removable message, which must then be demoted too (e.g. parallel tool calls
	 * where one result is outside the group — the assistant message can't be removed, so neither
	 * can the call whose result IS inside, cascading until nothing collapses). Mirroring the wire
	 * here keeps the VIEW's token accounting byte-faithful to what the agent actually receives.
	 *
	 * DURABILITY (ADR: the GUI must mirror exactly what the agent receives, issue #13): the wire
	 * (`computeGroupOps` → `applyPlan`) strips non-durable ids, so a message containing a
	 * POSITIONAL (non-durable) id is NEVER removed on the wire — it stays live and splits the
	 * collapsed run around it. In a LIVE session (`wireAttached` — a real pi wire is attached, so a
	 * model actually receives what `applyPlan` produces) the view mirrors that exactly: such a
	 * message is a straggler here too. In a DEMO / loaded session there is no wire (no model
	 * receives anything), so the view stays durability-AGNOSTIC — it shows the logical collapse so
	 * demo/loaded sessions render real savings. This is the group-analog of the already-accepted
	 * "non-durable folds preview in demo" behavior; only live sessions enforce the mirror invariant.
	 */
	private classifyGroup(g: Group): GroupShape {
		const members: Block[] = [];
		for (const id of g.memberIds) {
			const b = this.get(id);
			if (b) members.push(b);
		}
		// Group member blocks by their message key — removal is per MESSAGE (a group never splits
		// an assistant message's parts), so the fixpoint reasons about whole messages.
		const byMsg = new Map<string, Block[]>();
		for (const b of members) {
			const k = messageKey(b.id);
			const arr = byMsg.get(k);
			if (arr) arr.push(b);
			else byMsg.set(k, [b]);
		}
		// Map preserves insertion order → these are the message keys in member/conversation order.
		const msgOrder = [...byMsg.keys()];
		// Per-message tool-pair callIds (mirror of mapping.ts `messageInfo`): a message's `calls`
		// are its tool_call callIds, its `results` the tool_result callIds it emits.
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
		// Initial removable set: every member message EXCEPT those the wire would never remove.
		// In a LIVE session a message holding a POSITIONAL (non-durable) id stays live on the wire
		// (computeGroupOps/applyPlan strip non-durable ids → the message isn't group-removable), so
		// it starts as a straggler here too — the view mirrors the wire (issue #13). In demo/loaded
		// sessions there is no wire, so the view stays durability-agnostic and collapses through it.
		const live = this.wireAttached;
		const removable = new Set<string>();
		for (const k of msgOrder) {
			const msgBlocks = byMsg.get(k)!;
			if (live && msgBlocks.some((b) => !isDurableId(b.id))) continue; // #13: non-durable → straggler on the wire
			removable.add(k);
		}
		// Fixpoint cascade (mirror of applyPlan Phase A): keep a removal only if its tool pairs are
		// fully inside the removal set. Repeat to a fixpoint (demoting one message can orphan a
		// partner in another, which must then be demoted too).
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
					removable.delete(k); // straggler: a tool-pair half is outside → keep this message live
					changed = true;
				}
			}
		} while (changed);
		const collapsed = new Set<string>();
		const stragglers = new Set<string>();
		const collapsedMembers: Block[] = [];
		// Maximal contiguous runs of collapsed members (in member order), split by any straggler —
		// the same run boundaries the wire's Phase B uses to insert one summary per run.
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
				run = null; // a straggler breaks the run
			}
		}
		return { members, collapsedMembers, collapsed, stragglers, carrier: collapsedMembers[0]?.id ?? null, collapsedRuns };
	}

	/**
	 * Index of the first protected block. Walking back from the newest block, protect whole
	 * blocks until the token target is reached, refusing to pull in the next older block if
	 * doing so would exceed a strict 25% whole-block overflow cap. That keeps the slider
	 * honest: 20k means roughly 20k, not 40k just because a huge boundary block happened to
	 * cross the threshold.
	 *
	 * Protection remains absolute for what IS inside the tail, and we always protect at
	 * least the newest block when target > 0. A single newest block may exceed the cap by
	 * itself — the cap only decides whether to add another older block.
	 */
	protectedFromIndex = $derived.by(() => {
		if (!this.blocks.length) return 0;
		// ADR 0011 `tail-size` lock: the holder's `activeTailTokens` (0 if omitted) drives the
		// walk-back; without the lock the human's `protectTokens` drives it. Both follow exactly
		// the same algorithm, so the boundary is stable across acquiring/releasing the lock.
		const target = this.isLocked("tail-size") ? this.activeTailTokens : this.protectTokens;
		// target === 0: protection disabled — every block is foldable.
		// blocks.length ⇒ isProtected is false everywhere.
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
	 * Is this block inside the protected working tail (never folded)? Resolves the
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

	// ---- housekeeping ------------------------------------------------------
	/**
	 * Dissolve any group that has come to reach into the protected tail (ADR 0006 watch
	 * item). Groups are created entirely older than the tail, but widening `protectTokens`
	 * can later grow the tail over an existing group. Protection is absolute, so rather than
	 * collapse protected content we drop the whole group — keeping the grid (older box uses
	 * the display list, protected box renders raw tiles) and the accounting consistent.
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
	 * Recompute engine housekeeping so the view stays consistent. Idempotent. With the
	 * conductor layer removed there is no automatic folding pass; this only enforces the two
	 * engine invariants that survive:
	 *
	 *   1. prune groups that reach into the protected tail;
	 *   2. heal a manual fold the protected tail has grown over.
	 *
	 * Named `refold` for history and for the ~30 callers that already invoke it.
	 */
	refold(): void {
		// A group can never overlap the protected tail; drop any that now does (e.g. the
		// tail was widened over it) before anything reads group state.
		this.pruneProtectedGroups();
		// Engine invariant — protection is ABSOLUTE: a block in the working tail is never
		// folded. Heal a manual fold the tail has grown over (e.g. the tail widened via
		// setProtect) so it springs back to live.
		this.healProtected(this.protectedFromIndex);
		this.version++;
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
		// ADR 0011 `tail-size` lock: the human can no longer resize the tail — the holder owns
		// it. A locked resize is a silent no-op (the UI shows the dial disabled to match).
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
		// written, no log. There is no human override to "win" under the lock.
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
		this.emit(by, "folded", label(b));
		this.refold();
	}
	unfold(id: string, by: Actor = "you"): void {
		// ADR 0011: two separate lock axes flow through this one method.
		//  • human-steering gates the human's hand-unfold (`by === "you"`).
		//  • agent-unfold gates the agent's `unfold` tool (`by === "agent"`, via resolveUnfold).
		// A refused agent unfold is a silent no-op here; `resolveUnfold` VERIFIES the block is
		// still folded after calling and reports the refusal as "missing" — this method does not
		// signal it.
		if (this.humanLocked(by)) return;
		if (by === "agent" && this.isLocked("agent-unfold")) return;
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "unfolded";
		b.by = by;
		this.emit(by, "unfolded", label(b));
		this.refold();
	}
	toggle(id: string, by: Actor = "you"): void {
		// ADR 0011 `human-steering`: gate early so a locked human toggle is a true no-op.
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
		this.emit("you", "pinned", label(b));
		this.refold();
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
	}
	/** Hand a block back to auto (no override). */
	auto(id: string): void {
		// ADR 0011 `human-steering`: clearing an override by hand is human steering — refused.
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
		// wholesale under the lock (no overrides cleared, no groups dropped, no log).
		if (this.isLocked("human-steering")) return;
		for (const b of this.blocks) {
			b.override = null;
			b.by = null;
		}
		// "Pure budget view" means NO manual fold construct survives — groups included.
		if (this.groups.length) this.groups = [];
		this.emit("you", "reset", "all blocks to auto");
		this.refold();
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
	/** What the group costs live: folded → one summary PER run (+ any straggler full); open → members' own eff. */
	groupLiveTokens(g: Group): number {
		if (!g.folded) {
			let n = 0;
			for (const b of this.groupMembers(g)) n += this.effTokens(b);
			return n;
		}
		const c = this.classifyGroup(g);
		// The wire inserts ONE summary message per contiguous collapsed RUN (a straggler in the
		// middle of the group splits the collapsed members into multiple runs). So the live cost is
		// (run count × one summary) + every straggler's full tokens. For a drop group summaryTok is
		// 0, so the run count is irrelevant (stays 0). One run (or none) reduces to the old behavior.
		let n = c.collapsedRuns.length * this.groupSummaryTok(g, c);
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
	 * is unknown. Pure — no validation, no mutation.
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
	 * `digest` is an optional summary override (mirrors `Group.digest`): `undefined` → default
	 * recap; `null`/`""` → drop (no wire message); non-empty string → verbatim.
	 */
	createGroup(startId: string, endId: string, by: Actor = "you", digest?: string | null): Group | null {
		// ADR 0011 `human-steering`: grouping is a human steering action — refused under the lock.
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
		this.emit(by, "grouped", `${memberIds.length} blocks`);
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
		// ADR 0011 `agent-unfold`: the agent forcing a folded GROUP open is gated on the same
		// axis as its per-block `unfold` — so `resolveUnfold`'s group path is refused under the
		// lock (and reports the code as missing).
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

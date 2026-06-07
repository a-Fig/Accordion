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
import type { Block, BlockKind, Actor, SessionMeta, ParsedSession, Group } from "./types";
import { digest, digestTokens, groupDigest, groupDigestTokens } from "./digest";

/**
 * The "message key" of a block id — the id with its assistant-part suffix removed, so
 * every part of one assistant message shares a key while a user/result/summary block is
 * its own key. Group creation snaps to whole messages on this key so a group never
 * collapses a message's parts in half (ADR 0006 §2/§4) — making GUI accounting message-exact.
 *
 * Two id regimes share this store, and both must collapse to the message:
 *  • LIVE wire (`live/mapping.ts`): assistant part = `a:<anchor>:p<j>` / `m<i>:p<j>` — the
 *    `p` prefix on the index disambiguates it.
 *  • LOADED / demo (`engine/parse.ts`): assistant part = `<eid>:<j>` — a BARE numeric index,
 *    no `p`. We must strip that too, or every part of a loaded assistant message snaps to its
 *    own key and the whole-message invariant silently degrades to per-part (breaks the Demo
 *    session). The catch: live SCALAR durable ids `u:<ts>` / `s:<ts>` / `r:<numericCallId>`
 *    also end in `:<digits>` and are each their OWN message — never strip those (a single
 *    lowercase type-letter + colon + digits is the tell).
 */
function messageKey(id: string): string {
	const live = id.match(/^(.*):p(?:\d+|\?)$/);
	if (live) return live[1];
	const parsed = id.match(/^(.+):\d+$/);
	if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
	return id;
}

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

/** Lower value → folded sooner. The whole asymmetry the tool is built around. */
const FOLD_RANK: Record<BlockKind, number> = {
	tool_result: 0, // huge, decays fastest → fold first, hardest
	thinking: 1, // ephemeral reasoning
	text: 2, // conclusions, medium durable value
	tool_call: 3, // tiny + durable record of an action → fold last
	user: 4, // the instruction/intent → fold last of all
};

export interface LogEntry {
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
	 * The protected working tail: the most recent blocks whose combined full size
	 * reaches this many tokens are NEVER auto-folded. The automatic folder and the
	 * future Conductor only ever operate on context older than this window — the
	 * recent ~N tokens stay verbatim. (Manual fold by the user is still allowed.)
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
		return this.isFolded(b) ? digestTokens(b) : b.tokens;
	}
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
	pinnedCount = $derived.by(() => {
		let n = 0;
		// A block pinned BEFORE it was grouped keeps its "pinned" override (members keep their
		// override, ADR §2), but a folded group collapses it on the wire — so it reads folded.
		// Don't count it as pinned, or the header contradicts what the user sees (a collapsed
		// tile reported as pinned).
		for (const b of this.blocks) if (b.override === "pinned" && !this.groupWire.get(b.id)?.collapsed) n++;
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
			const summaryTok = c.carrier ? groupDigestTokens(g, c.collapsedMembers) : 0;
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
	 * Index of the first protected block. Walking back from the newest block, the
	 * most recent blocks whose combined full size reaches `protectTokens` are
	 * protected; blocks at this index and later are never auto-folded. Always
	 * protects at least the newest block. Returns 0 if the whole session is
	 * smaller than the protected window (then nothing is fold-eligible).
	 */
	protectedFromIndex = $derived.by(() => {
		let sum = 0;
		for (let i = this.blocks.length - 1; i >= 0; i--) {
			sum += this.blocks[i].tokens;
			if (sum >= this.protectTokens) return i;
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
	 * Recompute every auto-controlled block from scratch so the live context fits
	 * the budget. Idempotent: same blocks + budget + overrides → same result.
	 */
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

	refold(): void {
		// A group can never overlap the protected tail; drop any that now does (e.g. the
		// tail was widened over it) before anything reads group state this pass.
		this.pruneProtectedGroups();
		// Compute the protected boundary once; folding never changes a block's full
		// `tokens`, so this index is stable for the whole pass.
		const protectedFrom = this.protectedFromIndex;

		// 1) Reset auto-controlled blocks to full, AND heal any protected block that
		// is still folded by a manual override. Protection is ABSOLUTE: a block in the
		// working tail is never folded, by the auto-folder OR the user. This also
		// self-corrects a block that became protected after being folded (e.g. the
		// tail grew via setProtect) — it springs back to live.
		this.blocks.forEach((b, i) => {
			if (i >= protectedFrom && b.override === "folded") {
				// Protection is absolute, but do not silently erase the user intent - log the
				// forced unfold so the activity feed shows what happened.
				this.emit(b.by ?? "auto", "unfolded (protected)", label(b));
				b.override = null;
				b.by = null;
			}
			if (b.override === null) {
				b.autoFolded = false;
				if (b.by === "auto") b.by = null;
			}
		});
		this.version++;
		let live = this.liveTokens;
		if (live <= this.budget) return;

		// 2) fold lowest-value, oldest candidates until the live context fits.
		// Protect the recent working tail (the newest ~protectTokens of context),
		// and never fold a block whose digest wouldn't actually save tokens — folding
		// it would only grow the live context and churn the view.
		// Skip members of a folded group: they are already collapsed into the group's one
		// entry, so folding them individually would double-count against the group accounting.
		const cand = this.blocks
			.filter((b, i) => b.override === null && i < protectedFrom && !this.groupWire.has(b.id) && digestTokens(b) < b.tokens)
			.sort((a, b) => FOLD_RANK[a.kind] - FOLD_RANK[b.kind] || a.order - b.order);

		for (const b of cand) {
			if (live <= this.budget) break;
			b.autoFolded = true;
			b.by = "auto";
			live += digestTokens(b) - b.tokens;
		}
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

	fold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b || b.override === "pinned" || this.inFoldedGroup(id)) return;
		// Protected working tail is never folded — not even by an explicit user action.
		// (Pin it or widen the budget instead; protection is the safety pillar.)
		if (this.isProtected(b)) return;
		b.override = "folded";
		b.by = by;
		this.emit(by, "folded", label(b));
		this.refold();
	}
	unfold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "unfolded";
		b.by = by;
		this.emit(by, "unfolded", label(b));
		this.refold();
	}
	toggle(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return;
		b.override = "pinned";
		b.by = "you";
		this.emit("you", "pinned", label(b));
		this.refold();
	}
	unpin(id: string): void {
		const b = this.get(id);
		if (!b || b.override !== "pinned") return;
		b.override = null;
		b.by = "you";
		this.emit("you", "unpinned", label(b));
		this.refold();
	}
	/** Hand a block back to the automatic folder. */
	auto(id: string): void {
		const b = this.get(id);
		if (!b || this.inFoldedGroup(id)) return; // group controls collapsed members (like fold/pin)
		b.override = null;
		b.by = null;
		this.refold();
	}
	/** Clear every manual override — pure budget view. */
	resetAll(): void {
		for (const b of this.blocks) {
			b.override = null;
			b.by = null;
		}
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
	/** The one summary string the group's folded tile renders / the agent receives. */
	groupSummary(g: Group): string {
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
		let n = c.carrier ? groupDigestTokens(g, c.collapsedMembers) : 0;
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
	 * Create a group from a block range (the human's selection, any two member ids). The
	 * range is SNAPPED outward to whole messages (never splits an assistant message's parts),
	 * then validated: entirely older than the protected tail, no member already grouped
	 * (no overlap), ≥2 members. Folds it on creation. Returns the group, or null if invalid.
	 */
	createGroup(startId: string, endId: string, by: Actor = "you"): Group | null {
		const i0 = this.index.get(startId);
		const i1 = this.index.get(endId);
		if (i0 === undefined || i1 === undefined) return null;
		let lo = Math.min(i0, i1);
		let hi = Math.max(i0, i1);
		// Snap to whole messages so a group never collapses a message's parts in half.
		const keyLo = messageKey(this.blocks[lo].id);
		while (lo > 0 && messageKey(this.blocks[lo - 1].id) === keyLo) lo--;
		const keyHi = messageKey(this.blocks[hi].id);
		while (hi < this.blocks.length - 1 && messageKey(this.blocks[hi + 1].id) === keyHi) hi++;
		// Never reach into the protected tail (ADR 0006 §1).
		if (hi >= this.protectedFromIndex) return null;
		const memberIds: string[] = [];
		for (let i = lo; i <= hi; i++) {
			const b = this.blocks[i];
			if (this.groupAt.get(b.id)) return null; // overlap with an existing group
			memberIds.push(b.id);
		}
		if (memberIds.length < 2) return null;
		const g: Group = { id: `g:${memberIds[0]}`, memberIds, folded: true };
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
		const g = this.groupById(id);
		if (!g) return;
		this.groups = this.groups.filter((x) => x.id !== id);
		this.emit(by, "ungrouped", `${g.memberIds.length} blocks`);
		this.refold();
	}
	foldGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g || g.folded) return;
		g.folded = true;
		this.groups = [...this.groups];
		this.emit(by, "group folded", `${g.memberIds.length} blocks`);
		this.refold();
	}
	unfoldGroup(id: string, by: Actor = "you"): void {
		const g = this.groupById(id);
		if (!g || !g.folded) return;
		g.folded = false;
		this.groups = [...this.groups];
		this.emit(by, "group unfolded", `${g.memberIds.length} blocks`);
		this.refold();
	}
	toggleGroup(id: string, by: Actor = "you"): void {
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

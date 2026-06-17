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
import { messageKey } from "./ids";
import type { Conductor, ConductorView, Command, ClampReport, ClampReason } from "$conductors/contract";
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

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blocks = parsed.blocks;
		this.reindex();
		this.refold();
	}

	/** Swap the active conductor and immediately recompute the view. `null` ⇒ raw. */
	attach(c: Conductor | null): void {
		this.conductor = c;
		this.lastCmds = [];
		this.refold();
	}
	/** Detach any conductor: the context returns to raw, fully un-substituted. */
	detach(): void {
		this.attach(null);
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
	 * Index of the first protected block. Walking back from the newest block, protect
	 * whole blocks until the target `protectTokens` is reached, but refuse to pull in
	 * the next older block if doing so would exceed a strict 25% whole-block overflow
	 * cap. That keeps the slider honest: 20k means roughly 20k, not 40k just because a
	 * huge boundary block happened to cross the threshold.
	 *
	 * Protection remains absolute for what IS inside the tail, and we always protect at
	 * least the newest block. Therefore a single newest block may exceed the cap by
	 * itself — the cap only decides whether to add another older block.
	 */
	protectedFromIndex = $derived.by(() => {
		if (!this.blocks.length) return 0;
		const target = this.protectTokens;
		// Protection disabled: every block is foldable.
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
			protectTokens: this.protectTokens,
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
					this.groupCmd(c.ids, by, reports);
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
	 * Apply a `group` command by reusing the human group machinery (contiguous, ≥2,
	 * ungrouped, older than the tail). Human always wins: if SNAPPING the range would sweep
	 * a human-held block (pinned / manually folded / manually unfolded) into the collapse,
	 * refuse the whole group and report it — never silently override the human's choice.
	 * (Human-initiated groups go straight through `createGroup` and keep their old freedom.)
	 */
	private groupCmd(ids: string[], by: Actor, reports: ClampReport[]): void {
		if (ids.length < 2) return void reports.push(clamp("group", ids, "invalid-group", "a group needs ≥2 blocks"));
		const range = this.snappedRange(ids[0], ids[ids.length - 1]);
		if (range) {
			const held = range.filter((id) => this.get(id)?.override != null);
			if (held.length)
				return void reports.push(clamp("group", ids, "human-override", `would collapse ${held.length} human-held block(s)`));
		}
		const g = this.createGroup(ids[0], ids[ids.length - 1], by);
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
		const b = this.get(id);
		if (!b) return;
		this.isFolded(b) ? this.unfold(id, by) : this.fold(id, by);
	}
	pin(id: string): void {
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
	 * (no overlap), ≥2 members. Folds it on creation. Returns the group, or null if invalid.
	 */
	createGroup(startId: string, endId: string, by: Actor = "you"): Group | null {
		const memberIds = this.snappedRange(startId, endId);
		if (!memberIds) return null;
		// Never reach into the protected tail (ADR 0006 §1).
		if ((this.index.get(memberIds[memberIds.length - 1]) ?? Infinity) >= this.protectedFromIndex) return null;
		for (const id of memberIds) {
			if (this.groupAt.get(id)) return null; // overlap with an existing group
		}
		if (memberIds.length < 2) return null;
		const g: Group = { id: `g:${memberIds[0]}`, memberIds, folded: true, by };
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

/** Build a ClampReport (host clamped a command to the validity floor instead of dropping it). */
function clamp(command: Command["kind"], ids: string[], reason: ClampReason, detail: string): ClampReport {
	return { command, ids, reason, detail };
}

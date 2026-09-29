/*
 * keel-lite.ts — a deterministic, collaborative, in-process budget keeper.
 *
 * A small deterministic subset of the Keel plan (`docs/keel-conductor-plan.md`), shaped by
 * SlopCode token profiles of DeepSeek V4 Flash under pi. Thinking is 55–58% of the context by
 * token mass and DeepSeek re-sends all of it on every call. Bash results are 18–23%, read results
 * 5–8%, and assistant text under 1%. So the lowest-value mass is OLD THINKING, then noisy bash
 * output, then stale file reads.
 *
 * The cache economics matter as much as the mass: a DeepSeek cache read costs ~2% of fresh input,
 * so every edit to an early block re-bills the whole suffix. keel-lite therefore edits in rare,
 * large EPOCHS behind a hysteresis band (HIGH/LOW), never dribbling one fold per turn.
 *
 *   1. ROOTS are never touched: `system` and every `user` block, the newest read of
 *      `AGENT_BRIEFING.md`, and the newest read of each of the newest `rootSpecPaths` (2)
 *      distinct `spec_*.md` paths. Older duplicate reads of a root path are superseded and treated
 *      like any other stale read. The newest reads of OLDER spec paths are "demoted roots": the
 *      ladder compacts them only at R6.
 *   2. EPOCH HYSTERESIS: nothing happens while the projected live tokens are under HIGH·budget.
 *      Once over, one epoch walks the ladder until the projection is at or below LOW·budget (or
 *      nothing eligible is left). The epoch plans SYNCHRONOUSLY inside the event handler that saw
 *      the crossing and commits as ONE transaction, which the in-process host applies before
 *      `propose` even returns. It never defers work to a later tick, because a single DeepSeek
 *      step can add ~15k tokens and a lagging reaction is exactly how async LLM-summary
 *      conductors overshoot the budget.
 *   3. ELIGIBLE: before the protected tail; not a root; not held (a human/agent override — never
 *      fought, never counted as savings); not in any group; not a `tool_call`, `system` or `user`.
 *   4. THE LADDER, rung by rung across the whole eligible region, oldest block first:
 *        R0  re-assert a lapsed decision of ours (e.g. the protected tail healed it and has since
 *            moved on) at its recorded form — part of the monotone contract, not a new decision
 *        R1  thinking                                   → plain fold
 *        R2  stale reads (path later re-read / written) → plain fold
 *        R3  bash results > 150 tok                     → recoverable head/tail trim
 *        R4  remaining `read` results                   → doorman skeleton (code, worth-it gate),
 *                                                          else plain fold when > 300 tok
 *        R5  remaining foldable blocks > 200 tok        → plain fold (deepens R3/R4 replaces)
 *        R6  demoted (older) spec reads                 → plain fold
 *        R7  oldest runs of whole assistant steps       → default-recap groups, ~8 steps each
 *      Each epoch restarts at R1 over the undecided blocks, so a later epoch naturally resumes
 *      where the last one stopped, and newer thinking is always spent before older bash output.
 *   5. MONOTONE: keel-lite only ever proposes `fold`, `replace` (on a still-live block) and `group`.
 *      It never proposes unfold/auto/ungroup, so no decision is ever reverted by the conductor
 *      itself; a replace can only be deepened into a plain fold. It declares NO locks, and every
 *      transformation stays recoverable: engine digests and default group recaps carry their own
 *      `{#code FOLDED}` tag, and every `replace` is proposed `recoverable: true`.
 *
 * WHY A RAW `Conductor`, NOT `ViewConductor`. `ViewConductor.applyDesired` re-derives the whole
 * plan every pass. It emits `auto` for folds that were swept into a desired group, then the group
 * op itself, so a clamped group re-opens its members (context GROWS, monotonicity breaks). It also
 * re-proposes clamped ops on every pass. keel-lite's decisions are add-only, so a thin raw
 * conductor that proposes exactly the new decisions, records only what `Truth.apply` applied,
 * and re-reads truth each epoch is both simpler and strictly monotone.
 */
import type { Conductor, ConductorHost, HostEvent, ViewBlock } from "../../../core/conductor/contract";
import type { Op, TxnResult } from "../../../core/ops";
import type { Block, Group } from "../../../core/types";
import { collapsibleMessageKeys, messageKey } from "../../../core/groupShape";
import { groupDigest } from "../../../core/digest";
import { BLOCK_OVERHEAD } from "../../../core/tokens";
import { classifyCodeRead } from "../doorman/classify";
import { detectLang, skeletonize } from "../doorman/skeletonize";

// ── knobs ─────────────────────────────────────────────────────────────────────────────────

export interface KeelLiteOptions {
	/** Start an epoch once projected live tokens reach `high · budget`. Default 0.85. */
	high?: number;
	/** An epoch stops once projected live tokens are at or below `low · budget`. Default 0.65. */
	low?: number;
	/** R3 trims bash results strictly larger than this (tokens). Default 150. */
	bashTrimMinTokens?: number;
	/** R3 keeps this many leading lines. Default 3. */
	trimHeadLines?: number;
	/** R3 keeps this many trailing lines. Default 12. */
	trimTailLines?: number;
	/** R3 caps every kept line at this many characters. Default 200. */
	trimLineChars?: number;
	/** R3 skips a trim that would not save at least this fraction of the block. Default 0.4. */
	trimMinSavings?: number;
	/** R4 plain-folds a non-skeletonizable read strictly larger than this (tokens). Default 300. */
	readFoldMinTokens?: number;
	/** R5 plain-folds any remaining foldable block strictly larger than this (tokens). Default 200. */
	deepFoldMinTokens?: number;
	/** R7 groups at most this many whole assistant steps per group. Default 8. */
	groupChunkSteps?: number;
	/** How many distinct `spec_*.md` paths (newest first) stay roots. Default 2. */
	rootSpecPaths?: number;
	/**
	 * Bash commands whose output R3 must NOT head/tail-trim (it stays whole until R5 folds it).
	 * Default: the SlopCode `platform_client.py guide …` manual — a trimmed manual would read as a
	 * complete but wrong one. `null` disables the exemption.
	 */
	wholeBashCommand?: RegExp | null;
}

export const KEEL_LITE_DEFAULTS: Readonly<Required<KeelLiteOptions>> = Object.freeze({
	high: 0.85,
	low: 0.65,
	bashTrimMinTokens: 150,
	trimHeadLines: 3,
	trimTailLines: 12,
	trimLineChars: 200,
	trimMinSavings: 0.4,
	readFoldMinTokens: 300,
	deepFoldMinTokens: 200,
	groupChunkSteps: 8,
	rootSpecPaths: 2,
	wholeBashCommand: /platform_client\.py["']?\s+guide\b/,
});

/** Tokens a recoverable `replace`'s `{#code FOLDED}` tag adds (the same allowance doorman uses). */
const TAG_OVERHEAD_TOKENS = 10;
/** Doorman's worth-it gate: a skeleton must be at most this fraction of the original. */
const MAX_SKELETON_RATIO = 0.6;

// ── tool families ─────────────────────────────────────────────────────────────────────────

const READ_TOOLS = new Set(["read", "read_file", "readfile", "view", "open"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "write_file", "edit_file", "create_file"]);
const BASH_TOOLS = new Set(["bash", "shell", "sh", "exec_command", "run_command", "execute", "powershell", "pwsh"]);
const FOLDABLE: ReadonlySet<ViewBlock["kind"]> = new Set(["text", "thinking", "tool_result"]);
const ASSISTANT_PART: ReadonlySet<ViewBlock["kind"]> = new Set(["text", "thinking", "tool_call"]);

const SPEC_BASENAME = /^spec_.+\.md$/i;
const BRIEFING_BASENAME = "agent_briefing.md";

// ── internal shapes ───────────────────────────────────────────────────────────────────────

/** 0 = inherited from truth on attach/resync (rung unknown). */
type Rung = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type Form = "fold" | "replace";

interface Decision {
	rung: Rung;
	form: Form;
	/** The replace body, kept so a lapsed replace can be re-asserted verbatim (R0). */
	content?: string;
}

interface PlannedBlock {
	id: string;
	rung: Rung;
	form: Form;
	content?: string;
	/** Projected cost of the block once this decision lands. */
	cost: number;
}

interface PlannedGroup {
	ids: string[];
	/** Projected tokens the group saves over its members' (already-planned) per-block cost. */
	saved: number;
}

interface ReadRef {
	idx: number;
	id: string;
	path: string;
	ranged: boolean;
}

/** Per-epoch structural reading of the log: roots, stale reads, tool families. */
interface Analysis {
	roots: Set<string>;
	demoted: Set<string>;
	stale: Set<string>;
	/** tool_results of the read family (a real read tool, not `cat` via bash). */
	reads: Set<string>;
	/** tool_results of the bash family that R3 may trim. */
	trimmableBash: Set<string>;
	callById: Map<string, ViewBlock>;
}

interface Step {
	start: number;
	end: number;
}

// ── the conductor ─────────────────────────────────────────────────────────────────────────

export class KeelLiteConductor implements Conductor {
	readonly id = "keel-lite";
	readonly label = "Keel-lite";
	readonly description =
		"Deterministic, collaborative budget keeper: in rare hysteresis epochs it folds old thinking, stale reads and bash noise oldest-first (then groups old steps), never touching the briefing, spec or user roots. No model calls, no locks, everything recoverable.";

	private readonly k: Readonly<Required<KeelLiteOptions>>;
	private host: ConductorHost | null = null;
	private off: (() => void) | null = null;
	/** True while one of our own transactions is in flight (its synchronous `state-changed` echo
	 *  and any event racing the reconcile are deferred, never planned twice). */
	private busy = false;
	private pending = false;
	private decisions = new Map<string, Decision>();
	private ownGroups = new Map<string, readonly string[]>();
	private epochs = 0;
	private savedTotal = 0;
	private lastStatus = "";

	constructor(opts: KeelLiteOptions = {}) {
		const k = { ...KEEL_LITE_DEFAULTS, ...stripUndefined(opts) };
		if (!(k.high > 0 && k.high <= 1)) throw new RangeError(`keel-lite: high must be in (0, 1], got ${k.high}`);
		if (!(k.low > 0 && k.low < k.high)) throw new RangeError(`keel-lite: low must be in (0, high), got ${k.low} (high ${k.high})`);
		if (!(k.trimMinSavings >= 0 && k.trimMinSavings < 1)) throw new RangeError(`keel-lite: trimMinSavings must be in [0, 1)`);
		if (!(k.groupChunkSteps >= 1)) throw new RangeError(`keel-lite: groupChunkSteps must be ≥ 1`);
		this.k = Object.freeze(k);
	}

	/** The effective knobs (defaults merged with constructor options). */
	get options(): Readonly<Required<KeelLiteOptions>> {
		return this.k;
	}

	attach(host: ConductorHost): void {
		this.host = host;
		this.rebuildFromTruth(host);
		this.off = host.on((e) => this.onEvent(e));
	}

	detach(): void {
		this.off?.();
		this.off = null;
		this.host?.setStatus(null);
		this.host = null;
		this.decisions.clear();
		this.ownGroups.clear();
		this.busy = false;
		this.pending = false;
	}

	private onEvent(e: HostEvent): void | Promise<void> {
		const host = this.host;
		if (!host) return;
		switch (e.type) {
			case "resync":
				// The host rebuilt its state: re-derive what is ours from truth, then re-evaluate.
				this.rebuildFromTruth(host);
				return this.evaluate();
			case "turn-committed":
			case "blocks-appended":
				return this.evaluate();
			case "state-changed":
				// Our own transaction echoes synchronously while `busy`; ignore it. Anything a human or
				// the agent did (unfold, budget, protect) is re-evaluated — never reverted.
				if (this.busy || e.changes.every((c) => c.by === "auto")) return;
				return this.evaluate();
			default:
				return;
		}
	}

	/**
	 * Plan and (if over HIGH) commit one epoch. Everything up to and including the `propose` call
	 * runs synchronously in the caller's tick; only the result reconciliation awaits.
	 */
	private evaluate(): void | Promise<void> {
		const host = this.host;
		if (!host) return;
		if (this.busy) {
			this.pending = true;
			return;
		}
		const plan = this.plan(host);
		if (!plan) return;
		return this.commit(host, plan);
	}

	// ── planning ───────────────────────────────────────────────────────────────────────────

	private plan(host: ConductorHost): EpochPlan | null {
		const st = host.stats();
		const budget = st.budget;
		if (!(budget > 0)) return null;
		this.prune(host);
		const live = st.liveTokens;
		if (live < this.k.high * budget) return null; // hysteresis: under HIGH, say nothing

		const blocks = host.blocks();
		const pfi = Math.min(st.protectedFromIndex, blocks.length);
		const target = this.k.low * budget;
		const a = this.analyze(blocks);

		const inAnyGroup = new Set<string>();
		for (const g of host.groups()) for (const id of g.memberIds) inAnyGroup.add(id);

		const planned = new Map<string, PlannedBlock>();
		const groups: PlannedGroup[] = [];
		const rungs = new Set<string>();
		let projected = live;

		/** Projected current cost of a block (after anything already planned this epoch). */
		const cur = (b: ViewBlock): number => planned.get(b.id)?.cost ?? (b.folded ? b.foldedTokens : b.tokens);
		/** Live / replaced / plain-folded, as far as this epoch knows. */
		const stateOf = (b: ViewBlock): "live" | Form => {
			const p = planned.get(b.id);
			if (p) return p.form;
			if (!b.folded) return "live";
			return this.decisions.get(b.id)?.form ?? "fold";
		};
		/** The engine-digest cost a plain fold would leave (a replaced block's `foldedTokens` is its
		 *  replace body, and a `fold` resets it to the engine digest). */
		const foldCost = (b: ViewBlock): number => {
			if (!b.folded && stateOf(b) === "live") return b.foldedTokens;
			const d = host.digestOf(b.id);
			return d === null ? b.foldedTokens : host.countTokens(d) + BLOCK_OVERHEAD;
		};
		/** Per-block eligibility (rule 3). Demoted roots pass only when `allowDemoted`. */
		const eligible = (b: ViewBlock, i: number, allowDemoted = false): boolean => {
			if (i >= pfi) return false;
			if (!FOLDABLE.has(b.kind)) return false; // system / user / tool_call
			if (b.held || b.grouped || inAnyGroup.has(b.id)) return false;
			if (a.roots.has(b.id)) return false;
			if (a.demoted.has(b.id) && !allowDemoted) return false;
			return true;
		};
		const done = (): boolean => projected <= target;
		const take = (b: ViewBlock, rung: Rung, form: Form, cost: number, content?: string, label = `R${rung}`): void => {
			const saved = cur(b) - cost;
			if (saved <= 0) return;
			planned.set(b.id, { id: b.id, rung, form, content, cost });
			projected -= saved;
			rungs.add(label);
		};

		const ladder: Array<[Rung, (b: ViewBlock, i: number) => void]> = [
			// R0 — re-assert a lapsed decision of ours at its recorded form.
			[
				0,
				(b, i) => {
					const d = this.decisions.get(b.id);
					if (!d || !eligible(b, i, true) || stateOf(b) !== "live") return;
					if (d.form === "replace" && d.content) take(b, d.rung, "replace", host.countTokens(d.content) + TAG_OVERHEAD_TOKENS, d.content, "R0");
					else take(b, d.rung, "fold", foldCost(b), undefined, "R0");
				},
			],
			// R1 — thinking.
			[
				1,
				(b, i) => {
					if (b.kind !== "thinking" || !eligible(b, i) || stateOf(b) !== "live") return;
					take(b, 1, "fold", foldCost(b));
				},
			],
			// R2 — stale reads (re-read or rewritten later).
			[
				2,
				(b, i) => {
					if (!a.stale.has(b.id) || !eligible(b, i) || stateOf(b) === "fold") return;
					take(b, 2, "fold", foldCost(b));
				},
			],
			// R3 — bash output head/tail trim.
			[
				3,
				(b, i) => {
					if (!a.trimmableBash.has(b.id) || !eligible(b, i) || stateOf(b) !== "live") return;
					if (b.tokens <= this.k.bashTrimMinTokens) return;
					const content = this.trim(host, b);
					if (content === null) return;
					const cost = host.countTokens(content) + TAG_OVERHEAD_TOKENS;
					if (cost > (1 - this.k.trimMinSavings) * b.tokens) return;
					take(b, 3, "replace", cost, content);
				},
			],
			// R4 — remaining reads: skeleton if code and worth it, else fold when large.
			[
				4,
				(b, i) => {
					if (!a.reads.has(b.id) || !eligible(b, i) || stateOf(b) !== "live") return;
					const sk = this.skeleton(host, b, a.callById);
					if (sk !== null) take(b, 4, "replace", sk.cost, sk.content);
					else if (b.tokens > this.k.readFoldMinTokens) take(b, 4, "fold", foldCost(b));
				},
			],
			// R5 — anything still big (text, other results, the guide, trimmed bash, skeletons).
			[
				5,
				(b, i) => {
					if (!eligible(b, i) || stateOf(b) === "fold" || b.tokens <= this.k.deepFoldMinTokens) return;
					take(b, 5, "fold", foldCost(b));
				},
			],
			// R6 — demoted roots (the newest reads of older spec paths).
			[
				6,
				(b, i) => {
					if (!a.demoted.has(b.id) || !eligible(b, i, true) || stateOf(b) === "fold") return;
					take(b, 6, "fold", foldCost(b));
				},
			],
		];

		for (const [, visit] of ladder) {
			if (done()) break;
			for (let i = 0; i < pfi && !done(); i++) visit(blocks[i], i);
		}

		// R7 — group the oldest runs of whole assistant steps, only if still over LOW.
		// Chunks are disjoint, so no member's cost needs updating between them.
		if (!done()) {
			for (const g of this.planGroups(host, blocks, pfi, a, inAnyGroup, cur)) {
				if (done()) break;
				groups.push(g);
				projected -= g.saved;
				rungs.add("R7");
			}
		}

		const blockOps = [...planned.values()];
		if (!blockOps.length && !groups.length) {
			this.publishStall(host, live, budget);
			return null;
		}
		return { live, budget, projected, blockOps, groups, rungs: [...rungs] };
	}

	/**
	 * R7 candidates: maximal runs of whole assistant steps (an assistant message plus the tool
	 * results answering its calls) in the eligible region, chunked to `groupChunkSteps` steps,
	 * oldest first. A run ends at anything that is not such a step — a user block, a root, a held
	 * or already-grouped block, the protected tail. Each chunk is snapped to message atoms and
	 * vetted with the exact fixpoint `Truth.opGroup` enforces (`collapsibleMessageKeys`), and must
	 * collapse WHOLE (no stragglers) so its projected savings are real.
	 */
	private planGroups(
		host: ConductorHost,
		blocks: readonly ViewBlock[],
		pfi: number,
		a: Analysis,
		inAnyGroup: Set<string>,
		cur: (b: ViewBlock) => number,
	): PlannedGroup[] {
		const groupable = (i: number): boolean => {
			const b = blocks[i];
			if (i >= pfi || b.held || b.grouped || inAnyGroup.has(b.id)) return false;
			if (a.roots.has(b.id) || a.demoted.has(b.id)) return false;
			return b.kind !== "system" && b.kind !== "user";
		};

		// Split the region into whole steps; `null` marks a run breaker.
		const steps: Array<Step | null> = [];
		let i = 0;
		while (i < pfi) {
			const b = blocks[i];
			if (!ASSISTANT_PART.has(b.kind) || messageKey(b.id) === b.id) {
				steps.push(null);
				i++;
				continue;
			}
			const key = messageKey(b.id);
			const start = i;
			const calls = new Set<string>();
			while (i < blocks.length && messageKey(blocks[i].id) === key) {
				if (blocks[i].kind === "tool_call" && blocks[i].callId) calls.add(blocks[i].callId!);
				i++;
			}
			const answered = new Set<string>();
			while (i < blocks.length && blocks[i].kind === "tool_result" && blocks[i].callId && calls.has(blocks[i].callId!) && !answered.has(blocks[i].callId!)) {
				answered.add(blocks[i].callId!);
				i++;
			}
			const end = i - 1;
			let whole = answered.size === calls.size;
			for (let j = start; whole && j <= end; j++) if (!groupable(j)) whole = false;
			steps.push(whole ? { start, end } : null);
		}

		const out: PlannedGroup[] = [];
		const flush = (chunk: Step[]): void => {
			while (chunk.length) {
				const g = this.vetGroup(host, blocks, chunk[0].start, chunk[chunk.length - 1].end, cur);
				if (g) {
					out.push(g);
					return;
				}
				chunk = chunk.slice(0, -1); // shrink from the newest end until it vets
			}
		};
		let chunk: Step[] = [];
		for (const s of steps) {
			if (s === null) {
				flush(chunk);
				chunk = [];
				continue;
			}
			chunk.push(s);
			if (chunk.length >= this.k.groupChunkSteps) {
				flush(chunk);
				chunk = [];
			}
		}
		flush(chunk);
		return out;
	}

	/** Snap [start, end] to message atoms, require a whole collapse, and price the recap. */
	private vetGroup(host: ConductorHost, blocks: readonly ViewBlock[], start: number, end: number, cur: (b: ViewBlock) => number): PlannedGroup | null {
		const snapped = snapToMessageAtoms(blocks, start, end);
		if (!snapped || snapped[0] !== start || snapped[1] !== end) return null;
		const members = blocks.slice(start, end + 1);
		const removable = collapsibleMessageKeys(members, true);
		if (members.some((m) => !removable.has(messageKey(m.id)))) return null; // stragglers → don't
		const ids = members.map((m) => m.id);
		// The default recap is a pure function of the group id and its members (`groupDigest`);
		// ViewBlock carries every field it reads (kind/turn/tokens/text).
		const shape: Group = { id: `g:${ids[0]}`, memberIds: ids, folded: true, by: "auto" };
		const recap = groupDigest(shape, members as unknown as Block[]);
		const cost = host.countTokens(recap) + BLOCK_OVERHEAD;
		let before = 0;
		for (const m of members) before += cur(m);
		const saved = before - cost;
		return saved > 0 ? { ids, saved } : null;
	}

	// ── commit ─────────────────────────────────────────────────────────────────────────────

	private async commit(host: ConductorHost, plan: EpochPlan): Promise<void> {
		const ops: Op[] = [];
		const meta: Array<{ kind: "block"; p: PlannedBlock } | { kind: "group"; g: PlannedGroup }> = [];
		for (const p of plan.blockOps) {
			ops.push(p.form === "replace" ? { kind: "replace", id: p.id, content: p.content ?? "", recoverable: true } : { kind: "fold", ids: [p.id] });
			meta.push({ kind: "block", p });
		}
		for (const g of plan.groups) {
			ops.push({ kind: "group", ids: g.ids }); // summary undefined ⇒ the tagged default recap
			meta.push({ kind: "group", g });
		}

		this.busy = true;
		try {
			let res: TxnResult;
			try {
				// The in-process host applies this synchronously, before the first await resumes.
				res = await host.propose({ baseRev: host.stats().rev, ops });
			} catch {
				return;
			}
			if (this.host !== host) return; // detached mid-flight

			let blocksApplied = 0;
			let groupsApplied = 0;
			res.results.forEach((r, i) => {
				if (!r.applied) return; // a clamped op is never recorded
				const m = meta[i];
				if (!m) return;
				if (m.kind === "block") {
					const prev = this.decisions.get(m.p.id);
					this.decisions.set(m.p.id, { rung: m.p.rung || prev?.rung || 0, form: m.p.form, content: m.p.content });
					blocksApplied++;
				} else {
					const gid = r.detail ?? `g:${m.g.ids[0]}`;
					this.ownGroups.set(gid, m.g.ids.slice());
					groupsApplied++;
				}
			});

			const after = host.stats();
			if (blocksApplied || groupsApplied) {
				this.epochs++;
				const saved = Math.max(0, plan.live - after.liveTokens);
				this.savedTotal += saved;
				this.publishEpoch(host, plan, after.liveTokens, saved, blocksApplied, groupsApplied);
			}
		} finally {
			// Always clear `busy`, even when reconciling throws (e.g. the host's `setStatus`), or every
			// later evaluate() would only set `pending` and keel-lite would go silent for the rest of
			// the session. The error itself still reaches the host.
			this.busy = false;
		}

		if (this.pending && this.host === host) {
			this.pending = false;
			await this.evaluate();
		}
	}

	// ── status ─────────────────────────────────────────────────────────────────────────────

	private publishEpoch(host: ConductorHost, plan: EpochPlan, after: number, saved: number, blocks: number, groups: number): void {
		const text =
			`epoch ${this.epochs} · ${plan.rungs.join("+")} · −${fmtTok(saved)} ` +
			`(${fmtTok(plan.live)}→${fmtTok(after)} of ${fmtTok(plan.budget)})` +
			(groups ? ` · +${groups} group${groups === 1 ? "" : "s"}` : "");
		this.lastStatus = text;
		host.setStatus(text, {
			epochs: this.epochs,
			rungs: plan.rungs.join("+"),
			live_before: plan.live,
			tokens_saved: saved,
			tokens_saved_total: this.savedTotal,
			blocks_decided: blocks,
			groups_made: groups,
			groups_total: this.ownGroups.size,
			live_tokens: after,
			budget: plan.budget,
		});
	}

	/** Over HIGH with nothing eligible (roots + tail alone exceed LOW): say so, once per change. */
	private publishStall(host: ConductorHost, live: number, budget: number): void {
		const text = `saturated · ${fmtTok(live)} of ${fmtTok(budget)} · nothing eligible left (roots + protected tail)`;
		if (text === this.lastStatus) return;
		this.lastStatus = text;
		host.setStatus(text, { epochs: this.epochs, tokens_saved_total: this.savedTotal, groups_total: this.ownGroups.size, live_tokens: live, budget, saturated: true });
	}

	// ── state rebuild / pruning ────────────────────────────────────────────────────────────

	/**
	 * Adopt truth's current strategy-owned state as ours (attach, resync). A folded, un-held,
	 * un-grouped block is ours (a detached conductor's work was frozen to the human, so any
	 * remaining auto fold is keel-lite's); `by: "auto"` groups likewise.
	 */
	private rebuildFromTruth(host: ConductorHost): void {
		this.decisions.clear();
		this.ownGroups.clear();
		for (const b of host.blocks()) {
			if (b.held || b.grouped || !b.folded || !FOLDABLE.has(b.kind)) continue;
			this.decisions.set(b.id, { rung: 0, form: this.inferForm(host, b) });
		}
		for (const g of host.groups()) if (g.by === "auto") this.ownGroups.set(g.id, g.memberIds.slice());
	}

	/** A folded block whose cost matches its engine digest is a plain fold; otherwise a replace. */
	private inferForm(host: ConductorHost, b: ViewBlock): Form {
		const d = host.digestOf(b.id);
		if (d === null) return "fold";
		const digestCost = host.countTokens(d) + BLOCK_OVERHEAD;
		return Math.abs(digestCost - b.foldedTokens) <= Math.max(3, 0.05 * digestCost) ? "fold" : "replace";
	}

	/** Forget decisions/groups whose blocks or groups vanished (structural rebuilds, tree nav). */
	private prune(host: ConductorHost): void {
		for (const id of [...this.decisions.keys()]) if (!host.get(id)) this.decisions.delete(id);
		if (this.ownGroups.size) {
			const live = new Set(host.groups().map((g) => g.id));
			for (const id of [...this.ownGroups.keys()]) if (!live.has(id)) this.ownGroups.delete(id);
		}
	}

	// ── structural analysis ────────────────────────────────────────────────────────────────

	private analyze(blocks: readonly ViewBlock[]): Analysis {
		const callById = new Map<string, ViewBlock>();
		const callIdx = new Map<string, number>();
		blocks.forEach((b, i) => {
			if (b.kind === "tool_call" && b.callId) {
				callById.set(b.callId, b);
				callIdx.set(b.callId, i);
			}
		});

		const reads: ReadRef[] = [];
		const writes: Array<{ idx: number; path: string }> = [];
		const readResults = new Set<string>();
		const trimmableBash = new Set<string>();

		blocks.forEach((b, i) => {
			if (b.kind === "tool_call") {
				const info = callInfo(b, undefined);
				if (WRITE_TOOLS.has(info.tool) && info.path) writes.push({ idx: i, path: info.path });
				return;
			}
			if (b.kind !== "tool_result") return;
			const call = b.callId ? callById.get(b.callId) : undefined;
			const info = callInfo(call, b);
			if (READ_TOOLS.has(info.tool)) {
				readResults.add(b.id);
				if (info.path && !b.isError) reads.push({ idx: i, id: b.id, path: info.path, ranged: info.ranged });
			} else if (BASH_TOOLS.has(info.tool)) {
				const whole = this.k.wholeBashCommand && info.command !== undefined && this.k.wholeBashCommand.test(info.command);
				if (!whole) trimmableBash.add(b.id);
				// A clean `cat <file>` is a read of that file for root/staleness purposes.
				const target = info.command !== undefined ? catTarget(info.command) : undefined;
				if (target && !b.isError) reads.push({ idx: i, id: b.id, path: target, ranged: false });
			}
		});

		// Stale: a later full re-read (or an identical-range re-read), or a later write/edit.
		const stale = new Set<string>();
		for (const r of reads) {
			const reread = reads.some((o) => o.idx > r.idx && samePath(o.path, r.path) && (!o.ranged || r.ranged));
			const rewritten = writes.some((w) => w.idx > r.idx && samePath(w.path, r.path));
			if (reread || rewritten) stale.add(r.id);
		}

		// Roots: the newest briefing read; the newest read of each of the newest N spec paths.
		const roots = new Set<string>();
		const demoted = new Set<string>();
		let briefing: ReadRef | undefined;
		const newestSpec = new Map<string, ReadRef>();
		for (const r of reads) {
			const base = baseName(r.path).toLowerCase();
			if (base === BRIEFING_BASENAME) {
				if (!briefing || r.idx > briefing.idx) briefing = r;
			} else if (SPEC_BASENAME.test(baseName(r.path))) {
				const prev = newestSpec.get(r.path);
				if (!prev || r.idx > prev.idx) newestSpec.set(r.path, r);
			}
		}
		if (briefing) roots.add(briefing.id);
		const specs = [...newestSpec.values()].sort((x, y) => y.idx - x.idx);
		specs.forEach((r, n) => (n < this.k.rootSpecPaths ? roots : demoted).add(r.id));
		for (const id of roots) stale.delete(id);
		for (const id of demoted) stale.delete(id);

		return { roots, demoted, stale, reads: readResults, trimmableBash, callById };
	}

	// ── transformations ────────────────────────────────────────────────────────────────────

	/**
	 * R3's head/tail trim: the first `trimHeadLines` and last `trimTailLines` lines, each capped at
	 * `trimLineChars`, around a one-line marker saying what was elided and how to get it back.
	 * Null when there is nothing to trim.
	 */
	private trim(host: ConductorHost, b: ViewBlock): string | null {
		const text = (b.text ?? host.textOf(b.id) ?? "").replace(/\s+$/, "");
		if (!text) return null;
		const lines = text.split("\n");
		const cap = (l: string): string => (l.length > this.k.trimLineChars ? `${l.slice(0, this.k.trimLineChars)}…` : l);
		const { trimHeadLines: h, trimTailLines: t } = this.k;
		if (lines.length <= h + t) {
			if (!lines.some((l) => l.length > this.k.trimLineChars)) return null;
			const kept = lines.map(cap);
			return `${kept.join("\n")}\n… long lines clipped to ${this.k.trimLineChars} chars — unfold to see full output …`;
		}
		const head = lines.slice(0, h).map(cap);
		const tail = lines.slice(lines.length - t).map(cap);
		const keptCost = host.countTokens([...head, ...tail].join("\n"));
		const elidedTok = Math.max(0, b.tokens - keptCost);
		const marker = `… ${lines.length - h - t} lines / ~${fmtTok(elidedTok)} tok elided — unfold to see full output …`;
		return [...head, marker, ...tail].join("\n");
	}

	/** R4's code skeleton via doorman's classifier + skeletonizer and its worth-it gate. */
	private skeleton(host: ConductorHost, b: ViewBlock, callById: Map<string, ViewBlock>): { content: string; cost: number } | null {
		const info = classifyCodeRead(b, callById);
		if (!info) return null;
		const sk = skeletonize(info.source, detectLang(info.path, info.source));
		if (sk.elidedLines === 0) return null;
		const header = `⟨code skeleton · ${info.path ?? "file"} · ${sk.totalLines}L → ${sk.keptLines}L · ${sk.elidedLines} elided · call unfold for full source⟩`;
		const content = `${header}\n${sk.skeleton}`;
		const cost = host.countTokens(content) + TAG_OVERHEAD_TOKENS;
		if (b.tokens - cost <= 0 || cost > b.tokens * MAX_SKELETON_RATIO) return null;
		return { content, cost };
	}
}

interface EpochPlan {
	live: number;
	budget: number;
	projected: number;
	blockOps: PlannedBlock[];
	groups: PlannedGroup[];
	rungs: string[];
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * Trim [start, end] inward to a fixed point where neither boundary straddles a message (the same
 * rule as `AgedSummaryConductor.snapToMessageAtoms`): `Truth.opGroup` WIDENS a straddling
 * boundary over its whole message, so a conductor must vet the snapped range, not the raw one.
 */
export function snapToMessageAtoms(blocks: readonly { id: string }[], start: number, end: number): [number, number] | null {
	const keyAt = (i: number) => messageKey(blocks[i].id);
	let lo = start;
	let hi = end;
	while (lo <= hi) {
		const frontStraddles = lo > 0 && keyAt(lo - 1) === keyAt(lo);
		const backStraddles = hi < blocks.length - 1 && keyAt(hi + 1) === keyAt(hi);
		if (!frontStraddles && !backStraddles) return [lo, hi];
		if (frontStraddles) lo++;
		else hi--;
	}
	return null;
}

interface CallInfo {
	tool: string;
	path?: string;
	command?: string;
	ranged: boolean;
}

/** The tool family and the args keel-lite cares about, recovered from the tool_call block. */
function callInfo(call: ViewBlock | undefined, result: ViewBlock | undefined): CallInfo {
	const text = call?.text;
	const own = (call?.toolName ?? result?.toolName ?? "").trim().toLowerCase();
	const tool = own && own !== "tool" ? own : (text?.trimStart().match(/^([^\s{]+)/)?.[1] ?? "").toLowerCase();
	const args = parseArgs(text);
	const rawPath = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
	return {
		tool,
		path: rawPath ? normPath(rawPath) : undefined,
		command: str(args.command),
		ranged: args.offset !== undefined || args.limit !== undefined || args.start_line !== undefined || args.end_line !== undefined,
	};
}

function parseArgs(text: string | undefined): Record<string, unknown> {
	if (typeof text !== "string") return {};
	const start = text.indexOf("{");
	if (start < 0) return {};
	try {
		const v = JSON.parse(text.slice(start));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v : undefined;
}

/** `cat <one file>` with nothing else on the line → that file; otherwise undefined. */
function catTarget(command: string): string | undefined {
	const m = command.match(/^\s*cat\s+(?:--\s+)?(["']?)([^\s"'|;&<>]+)\1\s*$/);
	return m ? normPath(m[2]) : undefined;
}

function normPath(p: string): string {
	let s = p.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	while (s.startsWith("./")) s = s.slice(2);
	return s;
}

/** Same file, allowing one side to be relative to the other (`src/a.py` vs `/w/src/a.py`). */
function samePath(a: string, b: string): boolean {
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function baseName(p: string): string {
	return p.slice(p.lastIndexOf("/") + 1);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}

function fmtTok(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.max(0, Math.round(n))}`;
}

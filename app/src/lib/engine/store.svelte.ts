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
import type { Block, BlockKind, Actor, SessionMeta, ParsedSession } from "./types";
import { digest, digestTokens } from "./digest";

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
	/** Never auto-fold the most recent N blocks. */
	hotTail = $state(2);
	log = $state<LogEntry[]>([]);
	private logN = 0;
	/** Bumped on every settled change — a cheap redraw signal for canvas views. */
	version = $state(0);

	constructor(parsed: ParsedSession) {
		this.meta = parsed.meta;
		this.blocks = parsed.blocks;
		this.refold();
	}

	// ---- reads -------------------------------------------------------------
	isFolded(b: Block): boolean {
		if (b.override === "folded") return true;
		if (b.override === "pinned" || b.override === "unfolded") return false;
		return b.autoFolded;
	}
	/** Tokens this block currently costs the live context. */
	effTokens(b: Block): number {
		return this.isFolded(b) ? digestTokens(b) : b.tokens;
	}
	digestOf(b: Block): string {
		return digest(b);
	}

	get liveTokens(): number {
		let n = 0;
		for (const b of this.blocks) n += this.effTokens(b);
		return n;
	}
	/** What the context would cost with nothing folded. */
	get fullTokens(): number {
		let n = 0;
		for (const b of this.blocks) n += b.tokens;
		return n;
	}
	get savedTokens(): number {
		return this.fullTokens - this.liveTokens;
	}
	get foldedCount(): number {
		return this.blocks.filter((b) => this.isFolded(b)).length;
	}
	get pinnedCount(): number {
		return this.blocks.filter((b) => b.override === "pinned").length;
	}
	get overBudget(): boolean {
		return this.liveTokens > this.budget;
	}

	// ---- the automatic folder ---------------------------------------------
	/**
	 * Recompute every auto-controlled block from scratch so the live context fits
	 * the budget. Idempotent: same blocks + budget + overrides → same result.
	 */
	refold(): void {
		// 1) hand all auto-controlled blocks back to full.
		for (const b of this.blocks) {
			if (b.override === null) {
				b.autoFolded = false;
				if (b.by === "auto") b.by = null;
			}
		}
		this.version++;
		let live = this.liveTokens;
		if (live <= this.budget) return;

		// 2) fold lowest-value, oldest candidates until the live context fits.
		// Protect the hot tail by array position (blocks are stored in order), and
		// never fold a block whose digest wouldn't actually save tokens — folding it
		// would only grow the live context and churn the view.
		const cutoff = this.blocks.length - 1 - this.hotTail;
		const cand = this.blocks
			.filter((b, i) => b.override === null && i <= cutoff && digestTokens(b) < b.tokens)
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

	// ---- manual actions ----------------------------------------------------
	private emit(by: Actor, action: string, detail: string): void {
		this.log.unshift({ by, action, detail, n: this.logN++ });
		if (this.log.length > 80) this.log.pop();
	}

	fold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b || b.override === "pinned") return;
		b.override = "folded";
		b.by = by;
		this.emit(by, "folded", label(b));
		this.refold();
	}
	unfold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b) return;
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
		if (!b) return;
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
		if (!b) return;
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

	get(id: string): Block | undefined {
		return this.blocks.find((b) => b.id === id);
	}
}

function label(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

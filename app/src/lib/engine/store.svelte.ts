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

	/**
	 * Index of the first protected block. Walking back from the newest block, the
	 * most recent blocks whose combined full size reaches `protectTokens` are
	 * protected; blocks at this index and later are never auto-folded. Always
	 * protects at least the newest block. Returns 0 if the whole session is
	 * smaller than the protected window (then nothing is fold-eligible).
	 */
	get protectedFromIndex(): number {
		let sum = 0;
		for (let i = this.blocks.length - 1; i >= 0; i--) {
			sum += this.blocks[i].tokens;
			if (sum >= this.protectTokens) return i;
		}
		return 0;
	}
	/** Is this block inside the protected working tail (never auto-folded)? */
	isProtected(b: Block): boolean {
		return this.blocks.indexOf(b) >= this.protectedFromIndex;
	}
	/** Full tokens currently held in the protected tail. */
	get protectedTokens(): number {
		let n = 0;
		for (let i = this.protectedFromIndex; i < this.blocks.length; i++) n += this.blocks[i].tokens;
		return n;
	}

	// ---- the automatic folder ---------------------------------------------
	/**
	 * Recompute every auto-controlled block from scratch so the live context fits
	 * the budget. Idempotent: same blocks + budget + overrides → same result.
	 */
	refold(): void {
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
		const cand = this.blocks
			.filter((b, i) => b.override === null && i < protectedFrom && digestTokens(b) < b.tokens)
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
		const seen = new Set(this.blocks.map((b) => b.id));
		const fresh: Block[] = [];
		for (const b of blocks) {
			if (seen.has(b.id)) continue; // already committed (or dup within this batch)
			seen.add(b.id);
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

	fold(id: string, by: Actor = "you"): void {
		const b = this.get(id);
		if (!b || b.override === "pinned") return;
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

/*
 * testhost.ts — a ConductorHost backed by a REAL Truth instance, for conductor unit tests.
 *
 * Phase-D agents golden-test conductors against this. It wraps a live `Truth`, translates its
 * events into `HostEvent`s, drives the host-level lifecycle (`commitTurn` / `departWire` /
 * `resync`), scripts `complete()` with canned successes AND rejections, captures `setStatus`
 * calls, and exposes the underlying `truth` for assertions. Make it pleasant.
 */
import { Truth } from "../truth";
import type { Block, ParsedSession } from "../types";
import { estTokens } from "../tokens";
import { digest } from "../digest";
import type { ConductorHost, HostEvent, ViewBlock, GroupInfo, CompletionRequest, CompletionResult, Op, TxnResult, TruthStats } from "./contract";
import type { TruthEvent } from "../events";
import { viewBlockOf, hostEventsFromTruthEvent, recallHostEvent, wireDepartingEvent } from "./hostAdapter";

function emptyLiveSession(): ParsedSession {
	return { meta: { format: "pi", title: "test", cwd: "", model: "test-model" }, blocks: [], lineCount: 0, skipped: 0 };
}

interface StatusCall {
	text: string | null;
	metrics?: Record<string, number | string | boolean>;
}

export class TestHost implements ConductorHost {
	readonly truth: Truth;
	/** Every request passed to `complete`, in order. */
	readonly completeLog: CompletionRequest[] = [];
	/** Every `setStatus` call, in order. */
	readonly statusLog: StatusCall[] = [];

	private listeners = new Set<(e: HostEvent) => void | Promise<void>>();
	private completeQueue: Array<{ ok: true; result: CompletionResult } | { ok: false; error: unknown }> = [];
	private turn = 0;

	constructor(parsed?: ParsedSession) {
		this.truth = new Truth(parsed ?? emptyLiveSession());
		this.truth.onEvent((e) => this.onTruthEvent(e));
	}

	// ── ConductorHost ─────────────────────────────────────────────────────────
	on(fn: (e: HostEvent) => void | Promise<void>): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	get(id: string): ViewBlock | undefined {
		const b = this.truth.get(id);
		return b ? viewBlockOf(this.truth, b) : undefined;
	}
	blocks(): readonly ViewBlock[] {
		return this.truth.blocks.map((b) => viewBlockOf(this.truth, b));
	}
	groups(): readonly GroupInfo[] {
		return this.truth.groups.map((g) => ({ id: g.id, memberIds: g.memberIds.slice(), folded: g.folded, by: g.by ?? null, summary: g.digest }));
	}
	textOf(id: string): string | null {
		return this.truth.get(id)?.text ?? null;
	}
	stats(): TruthStats {
		return this.truth.stats();
	}
	countTokens(text: string): number {
		return estTokens(text);
	}
	digestOf(id: string): string | null {
		const b = this.truth.get(id);
		return b ? digest(b) : null;
	}
	async complete(req: CompletionRequest): Promise<CompletionResult> {
		this.completeLog.push(req);
		const next = this.completeQueue.shift();
		if (!next) throw new Error("TestHost.complete: no scripted response queued");
		if (!next.ok) throw next.error;
		return next.result;
	}
	setStatus(text: string | null, metrics?: Record<string, number | string | boolean>): void {
		this.statusLog.push({ text, metrics });
	}
	propose(txn: { baseRev: number; ops: Op[] }): TxnResult {
		return this.truth.apply(txn.ops, "auto", txn.baseRev);
	}

	// ── test helpers ──────────────────────────────────────────────────────────
	/** Append blocks to the live log (fires `blocks-appended`). */
	appendBlocks(blocks: Block[]): void {
		this.truth.append(blocks);
	}
	/** Settle a turn — the canonical re-plan trigger for turn-based conductors. */
	commitTurn(turn?: number): void {
		this.turn = turn ?? this.turn + 1;
		this.fire({ type: "turn-committed", turn: this.turn, rev: this.truth.rev });
	}
	/**
	 * Fire `wire-departing` (honoring `holdWireUpToMs`: synchronous handlers get to propose a
	 * last-moment fold before we commit), then mark everything sent through the newest block —
	 * exactly the point at which the wire has departed to the model.
	 */
	departWire(): void {
		const { event, lastOrder } = wireDepartingEvent(this.truth);
		this.fire(event);
		if (lastOrder !== null) this.truth.markSent(lastOrder);
	}
	/** Signal a structural rebuild — subscribed conductors rebuild their tracked desired state. */
	resync(): void {
		this.fire({ type: "resync", rev: this.truth.rev });
	}

	humanFold(id: string): TxnResult {
		return this.truth.apply([{ kind: "fold", ids: [id] }], "you");
	}
	humanUnfold(id: string): TxnResult {
		return this.truth.apply([{ kind: "unfold", ids: [id] }], "you");
	}
	humanPin(id: string): TxnResult {
		return this.truth.apply([{ kind: "pin", ids: [id] }], "you");
	}
	humanUnpin(id: string): TxnResult {
		return this.truth.apply([{ kind: "unpin", ids: [id] }], "you");
	}
	humanReset(): TxnResult {
		return this.truth.apply([{ kind: "resetAll" }], "you");
	}
	agentUnfold(id: string): TxnResult {
		return this.truth.apply([{ kind: "unfold", ids: [id] }], "agent");
	}
	setProtect(n: number): void {
		this.truth.setProtect(n);
	}
	setBudget(n: number): void {
		this.truth.setBudget(n);
	}

	/** Queue a canned successful completion (FIFO). */
	queueCompletion(result: Partial<CompletionResult> & { text: string }): void {
		this.completeQueue.push({ ok: true, result: { model: "test-model", ...result } });
	}
	/** Queue a completion REJECTION — the "model unavailable / call failed" path. */
	queueCompletionError(error: unknown = new Error("scripted completion failure")): void {
		this.completeQueue.push({ ok: false, error });
	}

	/**
	 * Surface an agent `recall` observation (host-layer, refinement 5). Recall is a pure READ — it
	 * does not mutate fold state — so Truth cannot emit it; the host layer does, so a strategy that
	 * treats "the agent reached back into this block" as a signal can observe it.
	 */
	agentRecall(id: string): void {
		this.fire(recallHostEvent([id], "agent", this.truth.rev));
	}

	// ── internals ─────────────────────────────────────────────────────────────
	private fire(e: HostEvent): void {
		for (const fn of this.listeners) void fn(e);
	}
	private onTruthEvent(e: TruthEvent): void {
		for (const he of hostEventsFromTruthEvent(this.truth, e)) this.fire(he);
	}
}

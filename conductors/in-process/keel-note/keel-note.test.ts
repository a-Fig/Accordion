/*
 * keel-note.test.ts — conductor-level tests driven through `TestHost` (a real `Truth`, so every
 * op is clamped exactly as in a live session). No model is ever called: `NoteHost.complete` hands
 * each request to the test, which resolves or rejects it by hand (and so controls how "late" a
 * note lands). Sessions use durable ids, as in keel-lite's tests.
 */
import { describe, it, expect } from "vitest";
import { KeelNoteConductor, KEEL_NOTE_DEFAULTS, NOTE_HEADER, NOTE_SECTIONS, buildNoteRequest, cleanBody, fitNote } from "./keel-note";
import { KeelLiteConductor, KEEL_LITE_DEFAULTS } from "../keel-lite/keel-lite";
import { TestHost } from "../../../core/conductor/testhost";
import { hasOwnFoldTag } from "../../../core/digest";
import { entryById, keelNoteOptionsFromEnv } from "../../../core/conductor/registry";
import type { Block } from "../../../core/types";
import type { Op, TxnResult } from "../../../core/ops";
import type { CompletionRequest, CompletionResult, ViewBlock } from "../../../core/conductor/contract";

// ── session builder ─────────────────────────────────────────────────────────────────────────

interface Call {
	tool: string;
	args: Record<string, unknown>;
	out: string;
}
interface StepIds {
	think?: string;
	say?: string;
	calls: Array<{ call: string; result: string }>;
}

class Session {
	readonly blocks: Block[] = [];
	private order = 0;
	private resp = 0;
	private turn = 0;
	private flushed = 0;

	private push(b: Omit<Block, "order" | "turn" | "tokens" | "override" | "autoFolded" | "by">): string {
		this.blocks.push({ ...b, order: this.order++, turn: this.turn, tokens: Math.ceil(b.text.length / 4), override: null, autoFolded: false, by: null });
		return b.id;
	}
	user(text: string): string {
		this.turn++;
		return this.push({ id: `u:${1000 + this.order}`, kind: "user", text });
	}
	step(p: { think?: string; say?: string; calls?: Call[]; signed?: boolean }): StepIds {
		const r = ++this.resp;
		let j = 0;
		const ids: StepIds = { calls: [] };
		if (p.think !== undefined) ids.think = this.push({ id: `a:resp${r}:p${j++}`, kind: "thinking", text: p.think, ...(p.signed ? { signed: true } : {}) });
		if (p.say !== undefined) ids.say = this.push({ id: `a:resp${r}:p${j++}`, kind: "text", text: p.say });
		const calls = p.calls ?? [];
		const callIds = calls.map((c, n) => {
			const callId = `c${r}_${n}`;
			const id = this.push({ id: `a:resp${r}:p${j++}`, kind: "tool_call", text: `${c.tool} ${JSON.stringify(c.args)}`, toolName: c.tool, callId });
			return { id, callId };
		});
		calls.forEach((c, n) => {
			const { id, callId } = callIds[n];
			const result = this.push({ id: `r:${callId}`, kind: "tool_result", text: c.out, toolName: c.tool, callId });
			ids.calls.push({ call: id, result });
		});
		return ids;
	}
	flush(host: TestHost): void {
		host.appendBlocks(this.blocks.slice(this.flushed));
		this.flushed = this.blocks.length;
	}
}

function thought(chars: number, seed = 0): string {
	let s = `Thinking ${seed}: `;
	while (s.length < chars) s += `consider option ${seed} and its consequences carefully. `;
	return s.slice(0, chars);
}
function lines(n: number, width = 40, tag = "out"): string {
	const out: string[] = [];
	for (let i = 0; i < n; i++) out.push(`${tag} line ${i}: ${"x".repeat(width)}`);
	return out.join("\n");
}
const bash = (command: string, out: string): Call => ({ tool: "bash", args: { command }, out });

/** How big a step's thought is (chars), how many output lines its bash result has, what it says. */
interface Shape {
	think: number;
	out: number;
	say?: (i: number) => string | undefined;
	/** Every thought carries a provider signature (Anthropic-style). */
	signed?: boolean;
}
/**
 * SlopCode-like steps, thinking ~2/3 of the mass. Every epoch has to shed more than the new
 * thinking alone, so it folds ALL live thinking outside the protected tail and the note waits at
 * the tail edge (the steady state of the real replays too).
 */
const SLOP: Shape = { think: 2000, out: 20 };
/** Thinking-heavy steps: an epoch leaves live thinking behind, so there is a boundary block. */
const DEEP: Shape = { think: 4000, out: 3 };

/** The task, a one-line first thought, then `n` steps of `shape`. */
function session(n: number, shape: Shape = SLOP): { s: Session; steps: StepIds[] } {
	const s = new Session();
	s.user("Read AGENT_BRIEFING.md and complete the benchmark run it describes.");
	s.step({ think: "Let me start by reading the briefing file.", signed: shape.signed, calls: [bash("pwd && ls -la", lines(3, 20, "ls"))] });
	const steps: StepIds[] = [];
	for (let i = 0; i < n; i++) steps.push(s.step({ think: thought(shape.think, i), say: shape.say?.(i), signed: shape.signed, calls: [bash(`python run.py --case ${i}`, lines(shape.out, 40, `case${i}`))] }));
	return { s, steps };
}

/** A plausible model note, ~`bullets`×2 history lines. */
function noteBody(tag: string, bullets = 3): string {
	const out = [`${NOTE_SECTIONS[0]}:`, `- ${tag}: checkpoint 3/8 of circuit_eval`, `${NOTE_SECTIONS[1]}:`];
	for (let i = 0; i < bullets; i++) out.push(`- ${tag} built ${i}: implemented parser stage ${i} in circopt.py, 36/36 tests passed`);
	out.push(`${NOTE_SECTIONS[2]}:`);
	for (let i = 0; i < bullets; i++) out.push(`- ${tag} tried ${i}: vector slicing via approach ${i} → failed: IndexError in eval_slice`);
	out.push(`${NOTE_SECTIONS[3]}:`, `- FAILED tests/test_cp3.py::test_slice_${tag} - IndexError: list index out of range`);
	out.push(`${NOTE_SECTIONS[4]}:`, `- ${tag}-NEXT: fix eval_slice bounds, then resubmit checkpoint 3`);
	return out.join("\n");
}

/** Call on every trim, so each trim yields one call. Tests about the note's own mechanics use it. */
const EAGER = { minDroppedTokens: 0 } as const;

// ── host ────────────────────────────────────────────────────────────────────────────────────

interface Pending {
	req: CompletionRequest;
	resolve: (r: Partial<CompletionResult> & { text: string }) => void;
	reject: (e: unknown) => void;
	settled: boolean;
}

interface Txn {
	ops: Op[];
	res: TxnResult;
	/** `probe()` just before the transaction was proposed (the tests record the note's carrier). */
	carrierBefore: string | null;
}

/** Records every transaction; every `complete` waits until the test settles it by hand. */
class NoteHost extends TestHost {
	readonly txns: Txn[] = [];
	readonly calls: Pending[] = [];
	probe: (() => string | null) | null = null;
	override async propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		const carrierBefore = this.probe?.() ?? null;
		const res = await super.propose(txn);
		this.txns.push({ ops: txn.ops, res, carrierBefore });
		return res;
	}
	override complete(req: CompletionRequest): Promise<CompletionResult> {
		this.completeLog.push(req);
		return new Promise<CompletionResult>((resolve, reject) => {
			const p: Pending = {
				req,
				settled: false,
				resolve: (r) => {
					p.settled = true;
					resolve({ model: "test-model", ...r });
				},
				reject: (e) => {
					p.settled = true;
					reject(e);
				},
			};
			this.calls.push(p);
		});
	}
	/** keel-lite's epochs (everything but our note placements). */
	epochs(): Txn[] {
		return this.txns.filter((t) => !isPlacement(t));
	}
	/** Applied note placements (a non-recoverable replace, plus the old carrier's release). */
	landings(): Txn[] {
		return this.txns.filter((t) => isPlacement(t) && t.res.results[0]?.applied);
	}
}

const isPlacement = (t: { ops: Op[] }) => t.ops[0]?.kind === "replace" && t.ops[0].recoverable === false;

/** Throws synchronously (instead of rejecting) on the next `throwPlacements` note placements. */
class ThrowingHost extends NoteHost {
	throwPlacements = 0;
	override propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		if (this.throwPlacements > 0 && isPlacement(txn)) {
			this.throwPlacements--;
			throw new Error("host threw synchronously");
		}
		return super.propose(txn);
	}
}

/** Clamps the next `clampPlacements` note placements without applying anything. */
class ClampingHost extends NoteHost {
	clampPlacements = 0;
	readonly clamped: string[] = [];
	override propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		if (this.clampPlacements > 0 && isPlacement(txn)) {
			this.clampPlacements--;
			const carrierBefore = this.probe?.() ?? null;
			this.clamped.push(opIds(txn.ops[0])[0]);
			const res: TxnResult = { rev: this.stats().rev, results: txn.ops.map((op) => ({ op, applied: false, clamped: "noop" as const })) };
			this.txns.push({ ops: txn.ops, res, carrierBefore });
			return Promise.resolve(res);
		}
		return super.propose(txn);
	}
}

function setup<H extends NoteHost = NoteHost>(s: Session, opts: { protect?: number; budgetFactor?: number; budget?: number } = {}, host: H = new NoteHost() as H): H {
	s.flush(host);
	host.setProtect(opts.protect ?? 400);
	host.setBudget(opts.budget ?? Math.ceil(host.stats().liveTokens / (opts.budgetFactor ?? 0.9)));
	return host;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** Let settled note calls run their continuations (never waits for an unsettled call). */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await tick();
}
const costOf = (host: TestHost, id: string | null) => {
	const b = id ? host.get(id) : undefined;
	return b ? (b.folded ? b.foldedTokens : b.tokens) : 0;
};
const reserveOf = (host: TestHost, c: KeelNoteConductor, cap = KEEL_NOTE_DEFAULTS.noteMaxTokens) => Math.max(0, cap - costOf(host, c.noteState.carrierId));
const effOf = (host: TestHost, c: KeelNoteConductor, cap?: number) => host.stats().liveTokens + reserveOf(host, c, cap);
const substOf = (host: TestHost, id: string) => host.truth.get(id)!.subst;
const highOf = (host: TestHost) => KEEL_LITE_DEFAULTS.high * host.stats().budget;
const lowOf = (host: TestHost) => KEEL_LITE_DEFAULTS.low * host.stats().budget;
const opIds = (op: Op): string[] => (op.kind === "fold" || op.kind === "group" ? op.ids : op.kind === "replace" ? [op.id] : []);
const turnsOf = (req: CompletionRequest) => req.prompt.slice(req.prompt.indexOf("<my-earlier-turns>"), req.prompt.indexOf("</my-earlier-turns>"));
const prevOf = (req: CompletionRequest) => req.prompt.slice(req.prompt.indexOf("<previous-notes>"), req.prompt.indexOf("</previous-notes>"));
const metricsOf = (host: TestHost) => host.statusLog.at(-1)?.metrics ?? {};

/** Ids of the blocks currently showing a note (folded, with the note header in their substitution). */
const showingNote = (host: TestHost) => host.blocks().filter((b) => b.folded && (substOf(host, b.id) ?? "").includes(NOTE_HEADER)).map((b) => b.id);

/** Positions (block order) an epoch actually changed. */
function changedOrders(host: TestHost, t: Txn): number[] {
	const out: number[] = [];
	for (const r of t.res.results) {
		if (!r.applied) continue;
		const ids = r.perId ? r.perId.filter((p) => p.applied).map((p) => p.id) : opIds(r.op);
		for (const id of ids) {
			const b = host.get(id);
			if (b) out.push(b.order);
		}
	}
	return out;
}

/**
 * Where the spec puts the note, computed from the view alone: the first usable block (thinking,
 * the carrier itself, or live text ≤ 150 tokens) after the BOUNDARY, the oldest live thinking
 * outside the tail that a fold would shrink; with no such block, the last usable block before the
 * tail.
 */
function specCarrier(host: TestHost, carrierId: string | null): { id: string; tail: boolean } | null {
	const blocks = host.blocks();
	const first = blocks.findIndex((b) => b.kind === "user");
	const pfi = Math.min(host.stats().protectedFromIndex, blocks.length);
	const inGroup = new Set(host.groups().flatMap((g) => g.memberIds));
	const free = (b: ViewBlock) => !b.held && !b.grouped && !b.protected && !inGroup.has(b.id);
	const usable = (b: ViewBlock) => free(b) && ((b.kind === "thinking" && !b.signed) || (b.kind === "text" && (b.id === carrierId || (!b.folded && b.tokens <= 150))));
	const boundary = blocks.findIndex((b, i) => i > first && i < pfi && b.kind === "thinking" && !b.folded && free(b) && b.tokens > b.foldedTokens);
	if (boundary >= 0) for (let i = boundary + 1; i < pfi; i++) if (usable(blocks[i])) return { id: blocks[i].id, tail: false };
	for (let i = pfi - 1; i > first; i--) if (usable(blocks[i])) return { id: blocks[i].id, tail: true };
	return null;
}

/** Add one step and commit the turn. */
async function grow(host: NoteHost, s: Session, seed: number, thinkChars = 2000, shape: Shape = SLOP): Promise<StepIds> {
	const st = s.step({ think: thought(thinkChars, seed), say: shape.say?.(seed), signed: shape.signed, calls: [bash(`python run.py --case ${seed}`, lines(shape.out, 40, `grow${seed}`))] });
	s.flush(host);
	await host.commitTurn();
	return st;
}

/** Grow until keel-lite runs another epoch (bounded), then let the note's continuations run. */
async function growUntilEpoch(host: NoteHost, s: Session, seed: number, shape: Shape = SLOP): Promise<number> {
	const before = host.epochs().length;
	let n = 0;
	while (host.epochs().length === before && n < 60) {
		await grow(host, s, seed + n, shape.think, shape);
		n++;
	}
	expect(host.epochs().length).toBeGreaterThan(before);
	await settle();
	return seed + n;
}

/** A DEEP session with a first note (`tag`) resolved and placed by the second trim. */
async function withLandedNote<H extends NoteHost = NoteHost>(opts: ConstructorParameters<typeof KeelNoteConductor>[0] = EAGER, tag = "A", into?: H) {
	const { s, steps } = session(40, DEEP);
	const host = setup(s, { budgetFactor: 0.9 }, into ?? (new NoteHost() as H));
	const c = new KeelNoteConductor(opts);
	host.probe = () => c.noteState.carrierId;
	c.attach(host);
	await host.commitTurn(); // epoch 1 → call 1; nothing to place yet
	host.calls[0].resolve({ text: noteBody(tag) });
	await settle();
	const seed = await growUntilEpoch(host, s, 2000, DEEP); // epoch 2 places it
	expect(host.landings()).toHaveLength(1);
	const id = c.noteState.carrierId!;
	expect(specCarrier(host, id)).toEqual({ id, tail: false });
	return { s, steps, host, c, seed };
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe("keel-note · budget reserve", () => {
	it("reserves the whole cap inside keel-lite's budget math before any note exists", async () => {
		// live = 84% of budget: keel-lite alone says nothing; with the 600-token reserve keel-note trims.
		const a = session(12);
		const plain = setup(a.s, { budgetFactor: 0.84 });
		new KeelLiteConductor().attach(plain);
		await plain.commitTurn();
		expect(plain.txns).toHaveLength(0);

		const b = session(12);
		const host = setup(b.s, { budgetFactor: 0.84 });
		const c = new KeelNoteConductor();
		c.attach(host);
		expect(c.noteState.carrierId).toBeNull();
		expect(reserveOf(host, c)).toBe(KEEL_NOTE_DEFAULTS.noteMaxTokens);
		expect(effOf(host, c)).toBeGreaterThanOrEqual(highOf(host));
		await host.commitTurn();
		expect(host.epochs()).toHaveLength(1);
		expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host));
		expect(host.landings()).toHaveLength(0); // no note yet, nothing written anywhere
		expect(showingNote(host)).toEqual([]);
	});

	it("holds real + reserve under HIGH after every turn of a long run, and the note never drops out", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		const due = new Map<Pending, number>();
		let seen = 0;
		let landedTurns = 0;
		for (let t = 0; t < 90; t++) {
			// Settle every call 2 turns after it was made (the note then waits for the next trim).
			for (const p of host.calls.slice(seen)) due.set(p, t + 2);
			seen = host.calls.length;
			for (const [p, when] of due) if (when <= t && !p.settled) p.resolve({ text: noteBody(`n${t}`, 6), inputTokens: 5000, outputTokens: 450 });
			await settle();
			await grow(host, s, 100 + t, 1200 + (t % 5) * 900);
			await settle();

			if (c.noteState.body !== null) {
				landedTurns++;
				expect(costOf(host, c.noteState.carrierId)).toBeLessThanOrEqual(KEEL_NOTE_DEFAULTS.noteMaxTokens);
				expect(showingNote(host)).toEqual([c.noteState.carrierId]); // exactly one copy, in context
			}
			// keel-lite's post-turn guarantee, applied to the reserved context…
			expect(effOf(host, c)).toBeLessThan(highOf(host));
			// …so the real context (note included) is under it too.
			expect(host.stats().liveTokens).toBeLessThanOrEqual(effOf(host, c));
		}
		expect(host.epochs().length).toBeGreaterThan(5);
		expect(host.landings().length).toBeGreaterThan(2);
		expect(landedTurns).toBeGreaterThan(40);
		expect(metricsOf(host)).toMatchObject({ note_reasserts: 0 });
		expect(String(host.statusLog.at(-1)?.text)).not.toMatch(/saturated/);
	}, 60_000);

	it("batches trims: a call starts only once minDroppedTokens of trimmed text is pending", async () => {
		const { s, steps } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ minDroppedTokens: 6000 });
		c.attach(host);
		await host.commitTurn(); // epoch 1: its span waits
		expect(host.epochs()).toHaveLength(1);
		const first = c.noteState.pendingSpanTokens;
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(6000); // (the premise: one epoch is not enough)
		expect(host.calls).toHaveLength(0);
		const firstThought = host.textOf(steps.map((st) => st.think!).find((id) => host.get(id)!.folded)!)!.slice(0, 60);
		let seed = 700;
		while (host.calls.length === 0) {
			expect(c.noteState.pendingSpanTokens).toBeLessThan(6000);
			seed = await growUntilEpoch(host, s, seed);
		}
		// One call for several trims, carrying the first trim's text too.
		expect(host.epochs().length).toBeGreaterThanOrEqual(2);
		expect(host.calls).toHaveLength(1);
		const turns = turnsOf(host.calls[0].req);
		expect(turns).toContain(firstThought);
		expect(host.countTokens(turns)).toBeGreaterThanOrEqual(6000);
		expect(host.countTokens(turns)).toBeLessThanOrEqual(KEEL_NOTE_DEFAULTS.spanMaxTokens + 50);
		expect(c.noteState.pendingSpanTokens).toBe(0);
		expect(metricsOf(host)).toMatchObject({ note_calls: 1 });
		expect(Number(metricsOf(host).note_trims_seen)).toBe(host.epochs().length);
	});
});

describe("keel-note · boundary placement", () => {
	it("a finished note never lands without a trim, however long it waits", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn(); // epoch 1 → call 1
		host.calls[0].resolve({ text: noteBody("held", 4) });
		await settle();
		for (let t = 0; t < 12; t++) await host.commitTurn(); // turn boundaries, no epoch
		expect(host.epochs()).toHaveLength(1);
		expect(host.landings()).toHaveLength(0);
		expect(c.noteState.ready).toBe(true);
		const epochsBefore = host.epochs().length;
		await growUntilEpoch(host, s, 100);
		// It landed as the very next transaction after the epoch, before any request departs…
		expect(host.landings()).toHaveLength(1);
		expect(host.epochs()).toHaveLength(epochsBefore + 1); // …without forcing an epoch of its own…
		expect(host.txns.indexOf(host.landings()[0])).toBe(host.txns.indexOf(host.epochs().at(-1)!) + 1);
		expect(substOf(host, c.noteState.carrierId!)).toContain("held-NEXT");
		// …and inside the room keel-lite had already reserved for it.
		expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host) + 1);
		expect(metricsOf(host)).toMatchObject({ note_refreshes: 1, note_placements: 1, note_moves: 0 });
	});

	it("after every trim the note sits just past the boundary, and the next trim starts before it", async () => {
		const { s } = session(40, DEEP);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		host.probe = () => c.noteState.carrierId;
		c.attach(host);
		await host.commitTurn(); // epoch 1 → call 1
		let seed = 1000;
		for (let n = 0; n < 8; n++) {
			for (const p of host.calls) if (!p.settled) p.resolve({ text: noteBody(`e${n}`) });
			await settle();
			const epochs = host.epochs().length;
			seed = await growUntilEpoch(host, s, seed, DEEP);
			expect(host.epochs()).toHaveLength(epochs + 1);
			// The note (the one that was waiting) is on the first usable block past the boundary.
			const id = c.noteState.carrierId!;
			expect(specCarrier(host, id)).toEqual({ id, tail: false });
			expect(substOf(host, id)).toContain(`e${n}-NEXT`);
			expect(showingNote(host)).toEqual([id]);
			// The move keeps the budget math where the epoch left it (a digest of slack at most).
			expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host) + 40);
			expect(host.stats().liveTokens).toBeLessThanOrEqual(effOf(host, c));
		}
		// Every epoch after the first placement started strictly before the carrier it found, so
		// rewriting that carrier re-billed nothing the epoch did not already re-bill.
		const later = host.epochs().filter((t) => t.carrierBefore !== null);
		expect(later.length).toBeGreaterThanOrEqual(7);
		for (const t of later) {
			expect(t.ops.flatMap(opIds)).not.toContain(t.carrierBefore); // keel-lite never touched it
			expect(Math.min(...changedOrders(host, t))).toBeLessThan(host.get(t.carrierBefore!)!.order);
		}
		// Each placement rode in the same request as its epoch: the very next transaction.
		for (const l of host.landings()) expect(host.epochs()).toContain(host.txns[host.txns.indexOf(l) - 1]);
		expect(metricsOf(host)).toMatchObject({ note_placements: 8, note_refreshes: 8, note_moves: 7, note_tail_placements: 0, note_reasserts: 0 });
	});

	it("with no new note, every trim still moves the current note forward: it is never lost", async () => {
		const { s, host, c } = await withLandedNote(EAGER, "K");
		let seed = 3000;
		// Call 2 (kicked by epoch 2) is never answered, so no new note arrives.
		const carriers = [c.noteState.carrierId!];
		for (let n = 0; n < 5; n++) {
			seed = await growUntilEpoch(host, s, seed, DEEP);
			const id = c.noteState.carrierId!;
			expect(id).not.toBe(carriers.at(-1));
			carriers.push(id);
			expect(showingNote(host)).toEqual([id]); // exactly one copy, on the new carrier
			expect(substOf(host, id)).toContain("K-NEXT"); // the same note, re-placed unchanged
			for (const old of carriers.slice(0, -1)) {
				// A former thinking carrier is folded to its engine digest, like its neighbours.
				expect(host.get(old)!.folded).toBe(true);
				expect(substOf(host, old) ?? "").not.toContain(NOTE_HEADER);
			}
		}
		expect(host.calls).toHaveLength(2);
		expect(metricsOf(host)).toMatchObject({ note_refreshes: 1, note_placements: 6, note_moves: 5, note_reasserts: 0 });
	});

	it("keel-lite never folds, trims or groups the carrier, even under a brutal budget", async () => {
		const { host, c } = await withLandedNote(EAGER, "B");
		host.setBudget(Math.ceil(host.stats().liveTokens / 15)); // every rung, groups included
		await host.commitTurn();
		await settle();
		const brutal = host.epochs().slice(2);
		expect(brutal.flatMap((t) => t.ops).some((o) => o.kind === "group")).toBe(true);
		for (const t of brutal) for (const op of t.ops) expect(opIds(op)).not.toContain(t.carrierBefore);
		const id = c.noteState.carrierId!;
		expect(host.get(id)!.grouped).toBe(false);
		expect(host.groups().some((g) => g.memberIds.includes(id))).toBe(false);
		expect(showingNote(host)).toEqual([id]);
		expect(substOf(host, id)).toContain("B-NEXT");
	});

	it("with no live thinking left outside the tail, the note waits on the last usable block before it", async () => {
		const { s } = session(12);
		const host = setup(s, { protect: 300 });
		host.setBudget(Math.ceil(host.stats().liveTokens / 2)); // epoch 1 folds every thinking block
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		expect(specCarrier(host, null)?.tail).toBe(true); // (the premise)
		host.calls[0].resolve({ text: noteBody("T") });
		await settle();
		await growUntilEpoch(host, s, 4000);
		const id = c.noteState.carrierId!;
		expect(specCarrier(host, id)).toEqual({ id, tail: true });
		expect(host.get(id)!.protected).toBe(false);
		expect(showingNote(host)).toEqual([id]);
		expect(Number(metricsOf(host).note_tail_placements)).toBeGreaterThanOrEqual(1);
		// Here the next trim starts at the first block to leave the tail, AFTER the carrier: moving
		// the note re-bills the carrier's own tool calls and results (the replay measures this gap).
		const pfi = host.stats().protectedFromIndex;
		const between = host.blocks().slice(host.blocks().findIndex((b) => b.id === id) + 1, pfi);
		expect(between.every((b) => b.kind === "tool_call" || b.kind === "tool_result")).toBe(true);
	});

	it("a small text block past the boundary keeps its words, and gets them back when the note moves on", async () => {
		const shape: Shape = { ...DEEP, say: (i) => `Step ${i}: running case ${i}.` };
		const { s, steps } = session(40, shape);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("T") });
		await settle();
		let seed = await growUntilEpoch(host, s, 5000, shape);
		const first = c.noteState.carrierId!;
		const step = steps.find((st) => st.say === first);
		expect(step).toBeTruthy(); // the text of the boundary thought's own message
		expect(host.get(step!.think!)!.folded).toBe(false); // the boundary itself: the next trim folds it
		const words = host.truth.get(first)!.text;
		const landed = substOf(host, first)!;
		expect(landed.startsWith(`${words}\n\n${NOTE_HEADER}\n`)).toBe(true);
		expect(landed).toContain("T-NEXT");
		expect(host.get(first)!.foldedTokens).toBeLessThanOrEqual(KEEL_NOTE_DEFAULTS.noteMaxTokens);

		seed = await growUntilEpoch(host, s, seed, shape);
		const second = c.noteState.carrierId!;
		expect(second).not.toBe(first);
		expect(host.truth.get(second)!.kind).toBe("text");
		expect(host.get(first)!.folded).toBe(false); // its own words are back
		expect(showingNote(host)).toEqual([second]);
		expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host) + 40);
	});

	it("never rides a large text block: the next thinking block carries it", async () => {
		const shape: Shape = { ...DEEP, say: (i) => `Plan ${i}: ${"a long explanation of the approach. ".repeat(30)}` };
		const { s } = session(40, shape);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		let seed = 6000;
		for (let n = 0; n < 3; n++) {
			for (const p of host.calls) if (!p.settled) p.resolve({ text: noteBody(`L${n}`) });
			await settle();
			seed = await growUntilEpoch(host, s, seed, shape);
			const id = c.noteState.carrierId!;
			expect(host.truth.get(id)!.kind).toBe("thinking");
			expect(specCarrier(host, id)).toEqual({ id, tail: false });
		}
	});

	it("never overwrites a signed thinking block: small text blocks carry the note instead", async () => {
		// Text on every third step only, so the block right after the boundary is often a signed thought.
		const shape: Shape = { ...DEEP, signed: true, say: (i) => (i % 3 === 0 ? `Step ${i}: running case ${i}.` : undefined) };
		const { s } = session(40, shape);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		let seed = 9000;
		for (let n = 0; n < 3; n++) {
			for (const p of host.calls) if (!p.settled) p.resolve({ text: noteBody(`G${n}`) });
			await settle();
			seed = await growUntilEpoch(host, s, seed, shape);
			const id = c.noteState.carrierId!;
			expect(host.truth.get(id)!.kind).toBe("text");
			expect(specCarrier(host, id)?.id).toBe(id);
			expect(showingNote(host)).toEqual([id]);
		}
		const placed = host.txns.filter(isPlacement).map((t) => opIds(t.ops[0])[0]);
		expect(placed.length).toBeGreaterThanOrEqual(3);
		for (const id of placed) expect(host.get(id)!.signed).not.toBe(true);
	});

	it("with only signed thinking and no small text, the note is not placed, and the budget still holds", async () => {
		const shape: Shape = { ...DEEP, signed: true };
		const { s } = session(40, shape);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		let seed = 9500;
		for (let n = 0; n < 3; n++) {
			for (const p of host.calls) if (!p.settled) p.resolve({ text: noteBody(`N${n}`) });
			await settle();
			seed = await growUntilEpoch(host, s, seed, shape);
			expect(effOf(host, c)).toBeLessThanOrEqual(highOf(host)); // the full cap stays reserved
		}
		expect(host.txns.filter(isPlacement)).toHaveLength(0);
		expect(c.noteState).toMatchObject({ carrierId: null, ready: true });
		expect(showingNote(host)).toEqual([]);
		expect(host.calls.length).toBeGreaterThan(1); // the note still updates, waiting for a carrier
	});

	it("re-places the note when a human takes its carrier, and only then", async () => {
		const { host, c } = await withLandedNote(EAGER, "M");
		const carrier = c.noteState.carrierId!;
		host.humanUnfold(carrier); // a human reads the original thought
		expect(showingNote(host)).toEqual([]);
		await host.commitTurn();
		const moved = c.noteState.carrierId!;
		expect(moved).not.toBe(carrier);
		expect(showingNote(host)).toEqual([moved]);
		expect(substOf(host, moved)).toContain("M-NEXT");
		expect(host.get(carrier)!.folded).toBe(false); // the human's choice stands
		expect(metricsOf(host)).toMatchObject({ note_refreshes: 1, note_reasserts: 1 });
		// And never re-asserts when nothing changed (every rewrite re-bills the cache).
		const n = host.landings().length;
		await host.commitTurn();
		await host.commitTurn();
		expect(host.landings()).toHaveLength(n);
	});
});

describe("keel-note · note size", () => {
	it("caps an oversized note at noteMaxTokens, keeping the header, goal, failing test and next step", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		const huge = noteBody("big", 80); // ~3.3k tokens
		expect(host.countTokens(huge)).toBeGreaterThan(3000);
		host.calls[0].resolve({ text: "```\n" + huge + "\n```" });
		await settle();
		await growUntilEpoch(host, s, 7000);
		const carrier = c.noteState.carrierId!;
		const note = substOf(host, carrier)!;
		expect(host.get(carrier)!.foldedTokens).toBeLessThanOrEqual(KEEL_NOTE_DEFAULTS.noteMaxTokens);
		expect(note.startsWith(`${NOTE_HEADER}\n`)).toBe(true);
		expect(note).toContain("big: checkpoint 3/8");
		expect(note).toContain("test_slice_big - IndexError");
		expect(note).toContain("big-NEXT: fix eval_slice bounds");
		expect(note).not.toContain("```");
		// The OLDEST history bullets went first; the newest survived.
		expect(note).not.toContain("big built 0:");
		expect(note).toContain("big tried 79:");
		// Verbatim and non-recoverable: no fold handle the agent could unfold into the old thought.
		expect(hasOwnFoldTag(note, carrier)).toBe(false);
		expect(host.truth.get(carrier)!.text.startsWith("Thinking ")).toBe(true); // the original is kept in truth
	});

	it("honors a smaller cap", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ ...EAGER, noteMaxTokens: 150 });
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("small", 10) });
		await settle();
		await growUntilEpoch(host, s, 7100);
		expect(host.get(c.noteState.carrierId!)!.foldedTokens).toBeLessThanOrEqual(150);
		expect(host.calls[0].req.maxOutputTokens).toBe(225);
	});

	it("fitNote falls back to whole lines, then characters", () => {
		const cost = (t: string) => Math.ceil(t.length / 4) + 5;
		const oneLong = fitNote("x".repeat(4000), 100, cost);
		expect(cost(oneLong)).toBeLessThanOrEqual(100);
		expect(oneLong.startsWith(NOTE_HEADER)).toBe(true);
		expect(oneLong.endsWith("…")).toBe(true);
		const plain = fitNote(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"), 120, cost);
		expect(cost(plain)).toBeLessThanOrEqual(120);
		expect(plain).toContain("line 0");
		const fits = fitNote("short", 100, cost);
		expect(fits).toBe(`${NOTE_HEADER}\nshort`);
	});

	it("cleanBody strips fences and an echoed header", () => {
		expect(cleanBody("```markdown\nMy progress notes (whatever):\nNext step:\n- a\n\n\n\n- b\n```")).toBe("Next step:\n- a\n\n- b");
		expect(cleanBody("   ")).toBe("");
	});
});

describe("keel-note · span capture", () => {
	it("captures the dropped span at trim time, framed as the agent's own earlier turns", async () => {
		const { s, steps } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		expect(host.calls).toHaveLength(1);
		const folded = steps.map((st) => st.think!).filter((id) => host.get(id)!.folded);
		expect(folded.length).toBeGreaterThan(0);
		const req = host.calls[0].req;
		const turns = turnsOf(req);
		for (const id of folded) expect(turns).toContain(host.textOf(id)!.slice(0, 200));
		expect(turns).toContain("[my thinking]");
		expect(turns).toContain("[my tool call]"); // the folded thought's own calls, for context
		expect(prevOf(req)).toContain("(none yet)");
		expect(req.system).toMatch(/first person/i);
		expect(req.system).toMatch(/YOUR OWN earlier work in this same session/);
		expect(req.system).toMatch(/Never write "the previous agent"/);
		for (const sec of NOTE_SECTIONS) expect(req.system).toContain(`${sec}:`);
		expect(req.maxOutputTokens).toBe(Math.ceil(KEEL_NOTE_DEFAULTS.noteMaxTokens * 1.5));
		expect(req.signal).toBeInstanceOf(AbortSignal);
	});

	it("a thinking block the note overwrites goes into the next update, like any trimmed block", async () => {
		const { host, c } = await withLandedNote(EAGER, "W");
		const carrier = c.noteState.carrierId!;
		expect(host.truth.get(carrier)!.kind).toBe("thinking");
		expect(host.calls).toHaveLength(2); // epoch 2's span, kicked right after the placement
		expect(turnsOf(host.calls[1].req)).toContain(host.textOf(carrier)!.slice(0, 60));
		expect(prevOf(host.calls[1].req)).toContain("W-NEXT");
	});

	it("a clamped placement copies nothing: the thought it failed to overwrite stays live and out of the note input", async () => {
		const { s } = session(40, DEEP);
		const host = setup(s, { budgetFactor: 0.9 }, new ClampingHost());
		const c = new KeelNoteConductor(EAGER);
		host.probe = () => c.noteState.carrierId;
		c.attach(host);
		await host.commitTurn(); // epoch 1 → call 1
		host.calls[0].resolve({ text: noteBody("C") });
		await settle();
		host.clampPlacements = 1;
		let seed = await growUntilEpoch(host, s, 2000, DEEP); // epoch 2's placement is clamped
		expect(host.clamped).toHaveLength(1);
		const target = host.clamped[0];
		expect(host.truth.get(target)!.kind).toBe("thinking");
		expect(host.get(target)!.folded).toBe(false); // still live
		expect(c.noteState).toMatchObject({ carrierId: null, ready: true }); // the note waits for the next trim
		const words = host.textOf(target)!.slice(0, 60);
		const sent = host.calls.length;
		expect(sent).toBe(2); // epoch 2's span went out right after the clamp…
		expect(turnsOf(host.calls[1].req)).not.toContain(words); // …without the live thought
		// Once the thought really leaves the view (trimmed, or overwritten by a later placement), the
		// next update gets it: the clamp did not mark it as seen.
		for (let n = 0; n < 6 && !host.get(target)!.folded; n++) {
			for (const p of host.calls) if (!p.settled) p.resolve({ text: noteBody(`C${n}`) });
			await settle();
			seed = await growUntilEpoch(host, s, seed, DEEP);
		}
		expect(host.get(target)!.folded).toBe(true);
		for (const p of host.calls) if (!p.settled) p.resolve({ text: noteBody("C-last") });
		await settle();
		seed = await growUntilEpoch(host, s, seed, DEEP);
		expect(host.calls.slice(sent).some((p) => turnsOf(p.req).includes(words))).toBe(true);
	});

	it("coalesces trims while an update is in flight, then chains one follow-up with the new spans", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		expect(host.calls).toHaveLength(1);
		const firstTurns = turnsOf(host.calls[0].req);

		const seed = await growUntilEpoch(host, s, 200);
		await growUntilEpoch(host, s, seed);
		expect(host.calls).toHaveLength(1); // two more trims, still one call
		expect(c.noteState.pendingSpanTokens).toBeGreaterThan(0);

		host.calls[0].resolve({ text: noteBody("first") });
		await settle();
		expect(host.calls).toHaveLength(2); // chained immediately, not on the next trim
		const second = host.calls[1].req;
		expect(prevOf(second)).toContain("first-NEXT"); // the not-yet-placed note is the input
		const thoughts = (t: string) => new Set(t.match(/Thinking \d+: /g) ?? []);
		const before = thoughts(firstTurns);
		const after = thoughts(turnsOf(second));
		expect(before.size).toBeGreaterThan(0);
		expect(after.size).toBeGreaterThan(0); // the later trims' content…
		for (const t of after) expect(before.has(t)).toBe(false); // …and nothing sent before
		expect(c.noteState.pendingSpanTokens).toBe(0);
	});

	it("bounds the pending span to the most recent spanMaxTokens", async () => {
		const { s, steps } = session(30);
		const host = setup(s, { budgetFactor: 0.9, protect: 300 });
		host.setBudget(Math.ceil(host.stats().liveTokens / 3)); // one deep epoch drops a lot
		const c = new KeelNoteConductor({ spanMaxTokens: 2000 });
		c.attach(host);
		await host.commitTurn();
		const turns = turnsOf(host.calls[0].req);
		expect(host.countTokens(turns)).toBeLessThanOrEqual(2000 + 50);
		const dropped = steps.map((st) => st.think!).filter((id) => host.get(id)!.folded || host.get(id)!.grouped);
		expect(dropped.length).toBeGreaterThan(5);
		expect(turns).not.toContain(host.textOf(dropped[0])!.slice(0, 40)); // oldest discarded
		expect(Number(metricsOf(host).note_discarded_span_tokens)).toBeGreaterThan(0);
	});

	it("clips each block head+tail", () => {
		const big = "A".repeat(3000) + "MIDDLE" + "Z".repeat(3000);
		const req = buildNoteRequest(null, [{ id: "x", order: 0, text: big, tokens: 1500 }], 600);
		expect(req.prompt).toContain("(none yet)");
		const closing = buildNoteRequest("</previous-notes> sneaky", [{ id: "y", order: 1, text: "</my-earlier-turns>", tokens: 5 }], 600);
		expect(closing.prompt.match(/<\/previous-notes>/g)).toHaveLength(1);
		expect(closing.prompt.match(/<\/my-earlier-turns>/g)).toHaveLength(1);
	});
});

describe("keel-note · failures", () => {
	it("a failed update keeps the old note in place and retries its spans on the next trigger", async () => {
		const { s, host, c, seed: s0 } = await withLandedNote({ ...EAGER, spanMaxTokens: 100_000 }, "A"); // (nothing discarded)
		expect(host.calls).toHaveLength(2);
		const failedTurns = turnsOf(host.calls[1].req);
		host.calls[1].reject(new Error("provider 503"));
		await settle();
		await host.commitTurn();
		expect(substOf(host, c.noteState.carrierId!)).toContain("A-NEXT"); // old note kept
		expect(host.statusLog.at(-1)?.text).toMatch(/last update failed \(provider 503\), kept previous/);
		expect(metricsOf(host)).toMatchObject({ note_failures: 1, note_refreshes: 1 });
		expect(host.calls).toHaveLength(2); // no immediate retry

		let seed = await growUntilEpoch(host, s, s0, DEEP);
		expect(showingNote(host)).toEqual([c.noteState.carrierId]); // moved, still the old note
		expect(substOf(host, c.noteState.carrierId!)).toContain("A-NEXT");
		expect(host.calls).toHaveLength(3);
		const retry = turnsOf(host.calls[2].req);
		const failedFirstThought = failedTurns.match(/Thinking \d+: /)?.[0];
		expect(failedFirstThought).toBeTruthy();
		expect(retry).toContain(failedFirstThought!); // the failed spans ride again
		host.calls[2].resolve({ text: noteBody("B") });
		await settle();
		seed = await growUntilEpoch(host, s, seed, DEEP);
		expect(substOf(host, c.noteState.carrierId!)).toContain("B-NEXT");
		expect(host.statusLog.at(-1)?.text).not.toMatch(/failed/);
	});

	it("a host whose propose throws synchronously leaves the note where it was, and the next trim still moves it", async () => {
		const { s, host, c, seed } = await withLandedNote(EAGER, "X", new ThrowingHost());
		const before = c.noteState.carrierId!;
		host.throwPlacements = 1;
		let next = await growUntilEpoch(host, s, seed, DEEP); // this epoch's move throws
		expect(host.throwPlacements).toBe(0);
		expect(c.noteState.carrierId).toBe(before); // rolled back to the block that still shows it
		expect(showingNote(host)).toEqual([before]);
		for (let n = 0; n < 2; n++) {
			next = await growUntilEpoch(host, s, next, DEEP);
			const id = c.noteState.carrierId!;
			expect(id).not.toBe(before); // not stuck: later trims move it again
			expect(showingNote(host)).toEqual([id]);
			expect(specCarrier(host, id)?.id).toBe(id);
		}
	});

	it("a hung update times out without ever blocking the agent loop", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ ...EAGER, timeoutMs: 20 });
		c.attach(host);
		await host.commitTurn(); // returns although the call never settles
		expect(c.noteState.inFlight).toBe(true);
		await grow(host, s, 400); // turns keep flowing
		await new Promise((r) => setTimeout(r, 60));
		await settle();
		expect(c.noteState.inFlight).toBe(false);
		expect(host.statusLog.at(-1)?.text).toMatch(/timed out/);
		expect(showingNote(host)).toEqual([]); // no note, nothing half-landed
		expect(c.noteState.pendingSpanTokens).toBeGreaterThan(0); // kept for the next trigger
		host.calls[0].resolve({ text: noteBody("too-late") }); // a straggler never lands
		await settle();
		await host.commitTurn();
		expect(host.landings()).toHaveLength(0);
	});

	it("an empty model reply counts as a failure", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: "  " });
		await settle();
		expect(metricsOf(host)).toMatchObject({ note_failures: 1 });
	});
});

describe("keel-note · fallback trigger", () => {
	it("refreshes every fallbackTurns turns when nothing is trimmed, and lands at the first trim", async () => {
		const { s } = session(6);
		const host = setup(s, { budget: 1_000_000, protect: 300 });
		const c = new KeelNoteConductor({ fallbackTurns: 5 });
		c.attach(host);
		for (let t = 0; t < 4; t++) await grow(host, s, 500 + t);
		expect(host.calls).toHaveLength(0);
		const last = await grow(host, s, 504); // 5th turn
		expect(host.epochs()).toHaveLength(0);
		expect(host.calls).toHaveLength(1);
		const turns = turnsOf(host.calls[0].req);
		expect(turns).toContain(host.textOf(last.think!)!.slice(0, 100)); // the newest work
		host.calls[0].resolve({ text: noteBody("F1") });
		await settle();
		await host.commitTurn();
		// Nothing was trimmed, so nothing needs a note in context yet: it waits.
		expect(host.landings()).toHaveLength(0);
		expect(c.noteState.ready).toBe(true);

		for (let t = 0; t < 4; t++) await grow(host, s, 600 + t);
		expect(host.calls).toHaveLength(2); // 5 turns since the last call
		const second = host.calls[1].req;
		expect(turnsOf(second)).not.toContain(host.textOf(last.think!)!.slice(0, 100)); // each block once
		expect(prevOf(second)).toContain("F1-NEXT"); // built on the waiting note
		expect(metricsOf(host)).toMatchObject({ note_fallbacks: 2 });

		host.calls[1].resolve({ text: noteBody("F2") });
		await settle();
		host.setBudget(Math.ceil(host.stats().liveTokens / 0.9)); // the first trim
		await host.commitTurn();
		await settle();
		expect(host.epochs()).toHaveLength(1);
		const id = c.noteState.carrierId!;
		expect(showingNote(host)).toEqual([id]);
		expect(substOf(host, id)).toContain("F2-NEXT");
	});

	it("a call resets the fallback clock; a trim that does not call does not", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ fallbackTurns: 3, minDroppedTokens: 1_000_000 }); // trims never call
		c.attach(host);
		await host.commitTurn(); // a trim, and turn 1 with no call
		expect(host.epochs()).toHaveLength(1);
		await host.commitTurn();
		expect(host.calls).toHaveLength(0);
		await host.commitTurn(); // turn 3: the fallback flushes the trim's pending span
		expect(host.calls).toHaveLength(1);
		expect(turnsOf(host.calls[0].req)).toContain("[my thinking]");
		expect(c.noteState.pendingSpanTokens).toBe(0);
		host.calls[0].resolve({ text: noteBody("F") });
		await settle();
		await grow(host, s, 800, 200);
		await grow(host, s, 801, 200);
		expect(host.calls).toHaveLength(1); // the clock restarted at the call
		await grow(host, s, 802, 200);
		expect(host.calls).toHaveLength(2);
		expect(turnsOf(host.calls[1].req)).toContain(host.textOf(s.blocks.at(-3)!.id)!.slice(0, 40)); // the newest step
		expect(metricsOf(host)).toMatchObject({ note_fallbacks: 2 });
	});
});

describe("keel-note · cost, lifecycle", () => {
	it("routes note calls through host.complete and reports their usage", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("U"), inputTokens: 4321, outputTokens: 456 });
		await settle();
		await growUntilEpoch(host, s, 8000);
		expect(host.completeLog).toHaveLength(2); // the second is epoch 2's, still in flight
		const m = metricsOf(host);
		expect(m).toMatchObject({ note_calls: 2, note_refreshes: 1, note_input_tokens: 4321, note_output_tokens: 456, note_tokens_estimated: false, epochs: 2 });
		expect(m.note_carrier).toBe(c.noteState.carrierId);
		expect(host.statusLog.at(-1)!.text).toMatch(/^epoch 2 · R1 · −.* · note: 1 refresh · updating$/);
	});

	it("detach aborts the in-flight call, clears status, and a late reply never lands", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor(EAGER);
		c.attach(host);
		await host.commitTurn();
		const req = host.calls[0].req;
		c.detach();
		expect(req.signal!.aborted).toBe(true);
		expect(host.statusLog.at(-1)).toEqual({ text: null, metrics: undefined });
		host.calls[0].resolve({ text: noteBody("ghost") });
		await tick();
		await host.commitTurn();
		expect(host.landings()).toHaveLength(0);
		expect(showingNote(host)).toEqual([]);
	});

	it("rejects out-of-range knobs", () => {
		expect(() => new KeelNoteConductor({ noteMaxTokens: 10 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ fallbackTurns: 0 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ spanMaxTokens: 100 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ minDroppedTokens: -1 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ minDroppedTokens: Number.NaN })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ keel: { high: 0.5, low: 0.7 } })).toThrow(RangeError);
	});
});

describe("keel-note · registry", () => {
	it("is a collaborative in-process entry", () => {
		expect(entryById("keel-note")).toMatchObject({ kind: "in-process", locks: [], holdWireUpToMs: 0, tailTokens: 0 });
		expect(entryById("keel-note")!.create!()).toBeInstanceOf(KeelNoteConductor);
	});

	it("reads its knobs from the environment, ignoring junk", () => {
		expect(keelNoteOptionsFromEnv({})).toEqual({ keel: { high: 0.85, low: 0.65 }, noteMaxTokens: undefined, minDroppedTokens: undefined, fallbackTurns: undefined, spanMaxTokens: undefined });
		expect(
			keelNoteOptionsFromEnv({
				ACCORDION_KEEL_NOTE_MAX_TOKENS: "800",
				ACCORDION_KEEL_NOTE_FALLBACK_TURNS: "20",
				ACCORDION_KEEL_NOTE_SPAN_TOKENS: "8000",
				ACCORDION_KEEL_NOTE_MIN_DROPPED_TOKENS: "4000",
				ACCORDION_KEEL_LITE_HIGH: "0.8",
			}),
		).toEqual({ keel: { high: 0.8, low: 0.65 }, noteMaxTokens: 800, minDroppedTokens: 4000, fallbackTurns: 20, spanMaxTokens: 8000 });
		const junk = keelNoteOptionsFromEnv({ ACCORDION_KEEL_NOTE_MAX_TOKENS: "12", ACCORDION_KEEL_NOTE_FALLBACK_TURNS: "2.5", ACCORDION_KEEL_NOTE_SPAN_TOKENS: "lots", ACCORDION_KEEL_NOTE_MIN_DROPPED_TOKENS: "-5" });
		expect(junk).toMatchObject({ noteMaxTokens: undefined, fallbackTurns: undefined, spanMaxTokens: undefined, minDroppedTokens: undefined });
		const c = new KeelNoteConductor(junk);
		expect(c.options.noteMaxTokens).toBe(600);
		expect(c.keelOptions.high).toBe(0.85);
	});
});

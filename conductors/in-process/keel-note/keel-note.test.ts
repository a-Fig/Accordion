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
import type { CompletionRequest, CompletionResult } from "../../../core/conductor/contract";

// ── session builder ─────────────────────────────────────────────────────────────────────────

interface Call {
	tool: string;
	args: Record<string, unknown>;
	out: string;
}
interface StepIds {
	think?: string;
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
	step(p: { think?: string; calls?: Call[] }): StepIds {
		const r = ++this.resp;
		let j = 0;
		const ids: StepIds = { calls: [] };
		if (p.think !== undefined) ids.think = this.push({ id: `a:resp${r}:p${j++}`, kind: "thinking", text: p.think });
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

/** A SlopCode-shaped start: the task, a one-line first thought (the carrier), then `n` big steps. */
function session(n: number): { s: Session; carrier: string; steps: StepIds[] } {
	const s = new Session();
	s.user("Read AGENT_BRIEFING.md and complete the benchmark run it describes.");
	const carrier = s.step({ think: "Let me start by reading the briefing file.", calls: [bash("pwd && ls -la", lines(3, 20, "ls"))] }).think!;
	const steps: StepIds[] = [];
	for (let i = 0; i < n; i++) steps.push(s.step({ think: thought(2000, i), calls: [bash(`python run.py --case ${i}`, lines(20, 40, `case${i}`))] }));
	return { s, carrier, steps };
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

// ── host ────────────────────────────────────────────────────────────────────────────────────

interface Pending {
	req: CompletionRequest;
	resolve: (r: Partial<CompletionResult> & { text: string }) => void;
	reject: (e: unknown) => void;
	settled: boolean;
}

/** Records every transaction; every `complete` waits until the test settles it by hand. */
class NoteHost extends TestHost {
	readonly txns: Array<{ ops: Op[]; res: TxnResult }> = [];
	readonly calls: Pending[] = [];
	override async propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		const res = await super.propose(txn);
		this.txns.push({ ops: txn.ops, res });
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
	/** keel-lite's epochs (everything but our non-recoverable note landings). */
	epochs(): Array<{ ops: Op[]; res: TxnResult }> {
		return this.txns.filter((t) => !t.ops.every(isLanding));
	}
	landings(): Array<{ ops: Op[]; res: TxnResult }> {
		return this.txns.filter((t) => t.ops.every(isLanding) && t.res.results[0]?.applied);
	}
}

const isLanding = (op: Op) => op.kind === "replace" && op.recoverable === false;

function setup(s: Session, opts: { protect?: number; budgetFactor?: number; budget?: number } = {}): NoteHost {
	const host = new NoteHost();
	s.flush(host);
	host.setProtect(opts.protect ?? 400);
	host.setBudget(opts.budget ?? Math.ceil(host.stats().liveTokens / (opts.budgetFactor ?? 0.9)));
	return host;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** Let settled note calls run their continuations (never waits for an unsettled call). */
async function settle(_c?: KeelNoteConductor): Promise<void> {
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

/** Add one big step and commit the turn. */
async function grow(host: NoteHost, s: Session, seed: number, thinkChars = 2000): Promise<StepIds> {
	const st = s.step({ think: thought(thinkChars, seed), calls: [bash(`python run.py --case ${seed}`, lines(20, 40, `grow${seed}`))] });
	s.flush(host);
	await host.commitTurn();
	return st;
}

/** Grow until keel-lite runs another epoch (bounded). */
async function growUntilEpoch(host: NoteHost, s: Session, seed: number): Promise<number> {
	const before = host.epochs().length;
	let n = 0;
	while (host.epochs().length === before && n < 60) await grow(host, s, seed + n++);
	expect(host.epochs().length).toBeGreaterThan(before);
	return seed + n;
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe("keel-note · budget reserve", () => {
	it("reserves the note inside keel-lite's budget math before any note exists", async () => {
		// live = 84% of budget: keel-lite alone says nothing; with a ~590-token reserve keel-note trims.
		const a = session(12);
		const plain = setup(a.s, { budgetFactor: 0.84 });
		new KeelLiteConductor().attach(plain);
		await plain.commitTurn();
		expect(plain.txns).toHaveLength(0);

		const b = session(12);
		const host = setup(b.s, { budgetFactor: 0.84 });
		const c = new KeelNoteConductor();
		c.attach(host);
		expect(c.noteState.carrierId).toBe(b.carrier);
		expect(host.stats().liveTokens + reserveOf(host, c)).toBeGreaterThanOrEqual(highOf(host));
		await host.commitTurn();
		expect(host.epochs()).toHaveLength(1);
		expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host));
		// The carrier still holds its original one-line thought: no note yet, nothing inserted.
		expect(host.get(b.carrier)!.folded).toBe(false);
	});

	it("keel-lite never folds, trims or groups the carrier, even under a brutal budget", async () => {
		const { s, carrier } = session(20);
		const host = setup(s, { protect: 300 });
		host.setBudget(Math.ceil(host.stats().liveTokens / 15)); // every rung, groups included
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		const ops = host.epochs().flatMap((t) => t.ops);
		expect(ops.some((o) => o.kind === "group")).toBe(true);
		for (const op of ops) expect(opIds(op)).not.toContain(carrier);
		expect(host.get(carrier)!.folded).toBe(false);
		expect(host.get(carrier)!.grouped).toBe(false);
		expect(host.groups().some((g) => g.memberIds.includes(carrier))).toBe(false);
	});

	it("holds real + reserve under HIGH after every turn of a long run with late-landing notes", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		const due = new Map<Pending, number>();
		let seen = 0;
		let landedTurns = 0;
		for (let t = 0; t < 90; t++) {
			// Settle every call 2 turns after it was made (the note lands one turn after that).
			for (const p of host.calls.slice(seen)) due.set(p, t + 2);
			seen = host.calls.length;
			for (const [p, when] of due) if (when <= t && !p.settled) p.resolve({ text: noteBody(`n${t}`, 6), inputTokens: 5000, outputTokens: 450 });
			await settle(c);
			await grow(host, s, 100 + t, 1200 + (t % 5) * 900);
			await settle(c);

			const carrierCost = costOf(host, c.noteState.carrierId);
			if (c.noteState.body !== null) {
				landedTurns++;
				expect(carrierCost).toBeLessThanOrEqual(KEEL_NOTE_DEFAULTS.noteMaxTokens);
			}
			// keel-lite's post-turn guarantee, applied to the reserved context…
			expect(effOf(host, c)).toBeLessThan(highOf(host));
			// …so the real context (note included) is under it too.
			expect(host.stats().liveTokens).toBeLessThanOrEqual(effOf(host, c));
		}
		expect(host.epochs().length).toBeGreaterThan(5);
		expect(host.landings().length).toBeGreaterThan(2);
		expect(landedTurns).toBeGreaterThan(40);
		expect(String(host.statusLog.at(-1)?.text)).not.toMatch(/saturated/);
	}, 60_000);

	it("a note landing right after a trim does not move the budget math or trigger an epoch", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn(); // epoch 1 → note call 1
		expect(host.epochs()).toHaveLength(1);
		expect(host.calls).toHaveLength(1);
		// Push to just under HIGH (the worst case for a landing), with the note still in flight.
		while (effOf(host, c) < highOf(host) - 700) await grow(host, s, 50, 400);
		const epochsBefore = host.epochs().length;
		const realBefore = host.stats().liveTokens;
		const effBefore = effOf(host, c);
		expect(effBefore).toBeLessThan(highOf(host));

		host.calls[0].resolve({ text: noteBody("late", 8) });
		await settle(c);
		await host.commitTurn(); // the landing turn: no new blocks
		expect(host.landings()).toHaveLength(1);
		expect(host.epochs()).toHaveLength(epochsBefore); // the landing alone never forces an epoch
		expect(host.stats().liveTokens).toBeGreaterThan(realBefore); // the note is bigger than the old thought…
		expect(Math.abs(effOf(host, c) - effBefore)).toBeLessThanOrEqual(2); // …but it was already reserved
		expect(substOf(host, carrier)!.startsWith(NOTE_HEADER)).toBe(true);
	});

	it("when a landing and an epoch share a turn, the epoch sees the landed note", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("shared", 8) });
		await settle(c);
		// A huge step crosses HIGH in the same turn the note lands.
		const before = host.epochs().length;
		s.step({ think: thought(9000, 7), calls: [bash("pytest -q", lines(60, 40, "big"))] });
		s.flush(host);
		await host.commitTurn();
		await settle(c);
		expect(host.landings()).toHaveLength(1);
		expect(host.epochs().length).toBeGreaterThan(before);
		expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host) + 1);
	});

	it("landDelayTurns holds a finished note for the next epoch, bounded by the delay", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ landDelayTurns: 50 });
		c.attach(host);
		await host.commitTurn(); // epoch 1 → note call 1
		host.calls[0].resolve({ text: noteBody("held", 4) });
		await settle(c);
		await grow(host, s, 60, 200); // a turn boundary with no epoch: the note waits
		expect(host.landings()).toHaveLength(0);
		expect(c.noteState.ready).toBe(true);
		await growUntilEpoch(host, s, 61);
		await settle(c);
		// It landed in the same turn as the epoch, right after it, and the invariant still holds.
		expect(host.landings()).toHaveLength(1);
		const landingIdx = host.txns.indexOf(host.landings()[0]);
		expect(host.txns.indexOf(host.epochs().at(-1)!)).toBe(landingIdx - 1);
		expect(substOf(host, carrier)!.startsWith(NOTE_HEADER)).toBe(true);
		expect(effOf(host, c)).toBeLessThanOrEqual(lowOf(host) + 1);

		// With a small delay, a note with no epoch in sight lands once the delay runs out.
		const d = session(12);
		const h2 = setup(d.s, { budgetFactor: 0.9 });
		const c2 = new KeelNoteConductor({ landDelayTurns: 2 });
		c2.attach(h2);
		await h2.commitTurn();
		h2.calls[0].resolve({ text: noteBody("late", 4) });
		await settle(c2);
		for (let t = 0; t < 2; t++) await grow(h2, d.s, 200 + t, 200);
		expect(h2.landings()).toHaveLength(0);
		await grow(h2, d.s, 202, 200);
		expect(h2.landings()).toHaveLength(1);
		expect(h2.epochs()).toHaveLength(1);
	});

	it("minLandGapTurns spaces fresh landings, and the newest update is the one that lands", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ minLandGapTurns: 40 });
		c.attach(host);
		await host.commitTurn(); // epoch 1 → call 1
		host.calls[0].resolve({ text: noteBody("first", 2) });
		await settle(c);
		let turns = 0;
		const step = async () => {
			await grow(host, s, 400 + turns, 200);
			turns++;
			await settle(c);
		};
		await step(); // the first note is exempt from the gap
		expect(host.landings()).toHaveLength(1);
		turns = 0;
		// Two more updates finish inside the gap: neither lands early.
		for (const tag of ["second", "third"]) {
			const before = host.calls.length;
			while (host.calls.length === before) {
				await step();
				expect(turns).toBeLessThan(40);
			}
			host.calls.at(-1)!.resolve({ text: noteBody(tag, 2) });
			await settle(c);
		}
		expect(host.landings()).toHaveLength(1);
		expect(c.noteState.ready).toBe(true);
		expect(prevOf(host.calls.at(-1)!.req)).toContain("second built 0"); // chained onto the waiting note
		while (host.landings().length === 1) await step();
		expect(turns).toBe(40);
		expect(substOf(host, carrier)).toContain("third built 0");
		expect(substOf(host, carrier)).not.toContain("second built 0");
	});
});

describe("keel-note · note size", () => {
	it("caps an oversized note at noteMaxTokens, keeping the header, goal, failing test and next step", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		const huge = noteBody("big", 80); // ~3.3k tokens
		expect(host.countTokens(huge)).toBeGreaterThan(3000);
		host.calls[0].resolve({ text: "```\n" + huge + "\n```" });
		await settle(c);
		await host.commitTurn();
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
		expect(host.truth.get(carrier)!.text).toBe("Let me start by reading the briefing file.");
	});

	it("honors a smaller cap", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ noteMaxTokens: 150 });
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("small", 10) });
		await settle(c);
		await host.commitTurn();
		expect(host.get(carrier)!.foldedTokens).toBeLessThanOrEqual(150);
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
		const { s, carrier, steps } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
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
		expect(turns).not.toContain(host.textOf(carrier)!);
		expect(prevOf(req)).toContain("(none yet)");
		expect(req.system).toMatch(/first person/i);
		expect(req.system).toMatch(/YOUR OWN earlier work in this same session/);
		expect(req.system).toMatch(/Never write "the previous agent"/);
		for (const sec of NOTE_SECTIONS) expect(req.system).toContain(`${sec}:`);
		expect(req.maxOutputTokens).toBe(Math.ceil(KEEL_NOTE_DEFAULTS.noteMaxTokens * 1.5));
		expect(req.signal).toBeInstanceOf(AbortSignal);
	});

	it("coalesces trims while an update is in flight, then chains one follow-up with the new spans", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		expect(host.calls).toHaveLength(1);
		const firstTurns = turnsOf(host.calls[0].req);

		const seed = await growUntilEpoch(host, s, 200);
		await growUntilEpoch(host, s, seed);
		expect(host.calls).toHaveLength(1); // two more trims, still one call
		expect(c.noteState.pendingSpanTokens).toBeGreaterThan(0);

		host.calls[0].resolve({ text: noteBody("first") });
		await settle(c);
		expect(host.calls).toHaveLength(2); // chained immediately, not on the next trim
		const second = host.calls[1].req;
		expect(prevOf(second)).toContain("first-NEXT"); // the not-yet-landed note is the input
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
		expect(Number(host.statusLog.at(-1)?.metrics?.note_discarded_span_tokens)).toBeGreaterThan(0);
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
	it("a failed update keeps the old note and retries its spans on the next trigger", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("A") });
		await settle(c);
		await host.commitTurn();
		expect(substOf(host, carrier)).toContain("A-NEXT");

		let seed = await growUntilEpoch(host, s, 300);
		expect(host.calls).toHaveLength(2);
		const failedTurns = turnsOf(host.calls[1].req);
		host.calls[1].reject(new Error("provider 503"));
		await settle(c);
		await host.commitTurn();
		expect(substOf(host, carrier)).toContain("A-NEXT"); // old note kept
		expect(host.statusLog.at(-1)?.text).toMatch(/last update failed \(provider 503\), kept previous/);
		expect(host.statusLog.at(-1)?.metrics).toMatchObject({ note_failures: 1, note_refreshes: 1 });
		expect(host.calls).toHaveLength(2); // no immediate retry

		seed = await growUntilEpoch(host, s, seed);
		expect(host.calls).toHaveLength(3);
		const retry = turnsOf(host.calls[2].req);
		const failedFirstThought = failedTurns.match(/Thinking \d+: /)?.[0];
		expect(failedFirstThought).toBeTruthy();
		expect(retry).toContain(failedFirstThought!); // the failed spans ride again
		host.calls[2].resolve({ text: noteBody("B") });
		await settle(c);
		await host.commitTurn();
		expect(substOf(host, carrier)).toContain("B-NEXT");
		expect(host.statusLog.at(-1)?.text).not.toMatch(/failed/);
	});

	it("a hung update times out without ever blocking the agent loop", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ timeoutMs: 20 });
		c.attach(host);
		await host.commitTurn(); // returns although the call never settles
		expect(c.noteState.inFlight).toBe(true);
		await grow(host, s, 400); // turns keep flowing
		await new Promise((r) => setTimeout(r, 60));
		await settle(c);
		expect(c.noteState.inFlight).toBe(false);
		expect(host.statusLog.at(-1)?.text).toMatch(/timed out/);
		expect(host.get(carrier)!.folded).toBe(false); // no note, nothing half-landed
		expect(c.noteState.pendingSpanTokens).toBeGreaterThan(0); // kept for the next trigger
		host.calls[0].resolve({ text: noteBody("too-late") }); // a straggler never lands
		await settle(c);
		await host.commitTurn();
		expect(host.landings()).toHaveLength(0);
	});

	it("an empty model reply counts as a failure", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: "  " });
		await settle(c);
		expect(host.statusLog.at(-1)?.metrics).toMatchObject({ note_failures: 1 });
	});
});

describe("keel-note · fallback trigger", () => {
	it("refreshes every fallbackTurns turns when nothing is trimmed", async () => {
		const { s, carrier } = session(6);
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
		expect(turns).not.toContain(host.textOf(carrier)!);
		host.calls[0].resolve({ text: noteBody("F1") });
		await settle(c);
		await host.commitTurn();
		expect(substOf(host, carrier)).toContain("F1-NEXT");

		for (let t = 0; t < 4; t++) await grow(host, s, 600 + t);
		expect(host.calls).toHaveLength(2); // 5 turns since the last fallback (the landing turn counted)
		const second = turnsOf(host.calls[1].req);
		expect(second).not.toContain(host.textOf(last.think!)!.slice(0, 100)); // each block once
		expect(host.statusLog.at(-1)?.metrics).toMatchObject({ note_fallbacks: 2 });
	});

	it("a trim resets the fallback clock", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor({ fallbackTurns: 3, minSpanTokens: 1_000_000 }); // trims never call
		c.attach(host);
		await host.commitTurn(); // trim → clock 0
		expect(host.epochs()).toHaveLength(1);
		expect(host.calls).toHaveLength(0);
		await host.commitTurn();
		await host.commitTurn();
		expect(host.calls).toHaveLength(0);
		await host.commitTurn();
		expect(host.calls).toHaveLength(1); // 3 turns after the trim: the fallback flushes its span
		expect(turnsOf(host.calls[0].req)).toContain("[my thinking]");
	});
});

describe("keel-note · carrier, cost, lifecycle", () => {
	it("moves the note when a human takes the carrier", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("M") });
		await settle(c);
		await host.commitTurn();
		expect(substOf(host, carrier)).toContain("M-NEXT");
		host.humanUnfold(carrier); // a human reads the original thought
		await host.commitTurn();
		const moved = c.noteState.carrierId!;
		expect(moved).not.toBe(carrier);
		expect(substOf(host, moved)).toContain("M-NEXT");
		expect(host.statusLog.at(-1)?.metrics).toMatchObject({ note_refreshes: 1, note_reasserts: 1 });
		// And never re-asserts when nothing changed (every re-assert re-bills the cache).
		const n = host.landings().length;
		await host.commitTurn();
		await host.commitTurn();
		expect(host.landings()).toHaveLength(n);
	});

	it("routes note calls through host.complete and reports their usage", async () => {
		const { s } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
		c.attach(host);
		await host.commitTurn();
		host.calls[0].resolve({ text: noteBody("U"), inputTokens: 4321, outputTokens: 456 });
		await settle(c);
		await host.commitTurn();
		expect(host.completeLog).toHaveLength(1);
		const m = host.statusLog.at(-1)!.metrics!;
		expect(m).toMatchObject({ note_calls: 1, note_refreshes: 1, note_input_tokens: 4321, note_output_tokens: 456, note_tokens_estimated: false, epochs: 1 });
		expect(host.statusLog.at(-1)!.text).toMatch(/^epoch 1 · R1 · −.* · note: 1 refresh$/);
	});

	it("detach aborts the in-flight call, clears status, and a late reply never lands", async () => {
		const { s, carrier } = session(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelNoteConductor();
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
		expect(host.get(carrier)!.folded).toBe(false);
	});

	it("rejects out-of-range knobs", () => {
		expect(() => new KeelNoteConductor({ noteMaxTokens: 10 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ fallbackTurns: 0 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ spanMaxTokens: 100 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ landDelayTurns: -1 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ landDelayTurns: 1.5 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ minLandGapTurns: -2 })).toThrow(RangeError);
		expect(() => new KeelNoteConductor({ keel: { high: 0.5, low: 0.7 } })).toThrow(RangeError);
	});
});

describe("keel-note · registry", () => {
	it("is a collaborative in-process entry", () => {
		expect(entryById("keel-note")).toMatchObject({ kind: "in-process", locks: [], holdWireUpToMs: 0, tailTokens: 0 });
		expect(entryById("keel-note")!.create!()).toBeInstanceOf(KeelNoteConductor);
	});

	it("reads its knobs from the environment, ignoring junk", () => {
		expect(keelNoteOptionsFromEnv({})).toEqual({ keel: { high: 0.85, low: 0.65 }, noteMaxTokens: undefined, fallbackTurns: undefined, spanMaxTokens: undefined, landDelayTurns: undefined, minLandGapTurns: undefined });
		expect(
			keelNoteOptionsFromEnv({
				ACCORDION_KEEL_NOTE_MAX_TOKENS: "800",
				ACCORDION_KEEL_NOTE_FALLBACK_TURNS: "20",
				ACCORDION_KEEL_NOTE_SPAN_TOKENS: "8000",
				ACCORDION_KEEL_NOTE_LAND_DELAY_TURNS: "4",
				ACCORDION_KEEL_NOTE_MIN_LAND_GAP_TURNS: "25",
				ACCORDION_KEEL_LITE_HIGH: "0.8",
			}),
		).toEqual({ keel: { high: 0.8, low: 0.65 }, noteMaxTokens: 800, fallbackTurns: 20, spanMaxTokens: 8000, landDelayTurns: 4, minLandGapTurns: 25 });
		const junk = keelNoteOptionsFromEnv({ ACCORDION_KEEL_NOTE_MAX_TOKENS: "12", ACCORDION_KEEL_NOTE_FALLBACK_TURNS: "2.5", ACCORDION_KEEL_NOTE_SPAN_TOKENS: "lots" });
		expect(junk).toMatchObject({ noteMaxTokens: undefined, fallbackTurns: undefined, spanMaxTokens: undefined });
		const c = new KeelNoteConductor(junk);
		expect(c.options.noteMaxTokens).toBe(600);
		expect(c.keelOptions.high).toBe(0.85);
	});
});

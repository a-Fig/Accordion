/*
 * keel-lite.test.ts — conductor-level tests driven through `TestHost` (a real `Truth`), so every
 * proposed op is clamped by the exact predicates a live session enforces. Sessions use DURABLE ids
 * (`u:`/`a:…:p<j>`/`r:<callId>`) because the group stage vets carriers with `requireDurable`.
 */
import { describe, it, expect } from "vitest";
import { KeelLiteConductor, KEEL_LITE_DEFAULTS, snapToMessageAtoms } from "./keel-lite";
import { TestHost } from "../../../core/conductor/testhost";
import { collapsibleMessageKeys, messageKey } from "../../../core/groupShape";
import { foldCode, hasOwnFoldTag } from "../../../core/digest";
import { resolveUnfold } from "../../../core/agentView";
import { entryById, keelLiteOptionsFromEnv } from "../../../core/conductor/registry";
import type { Block } from "../../../core/types";
import type { Op, TxnResult } from "../../../core/ops";

// ── session builder ─────────────────────────────────────────────────────────────────────────

interface Call {
	tool: string;
	args: Record<string, unknown>;
	out: string;
	isError?: boolean;
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
	step(p: { think?: string; say?: string; calls?: Call[] }): StepIds {
		const r = ++this.resp;
		let j = 0;
		const ids: StepIds = { calls: [] };
		if (p.think !== undefined) ids.think = this.push({ id: `a:resp${r}:p${j++}`, kind: "thinking", text: p.think });
		if (p.say !== undefined) ids.say = this.push({ id: `a:resp${r}:p${j++}`, kind: "text", text: p.say });
		const calls = p.calls ?? [];
		const callIds = calls.map((c, n) => {
			const callId = `c${r}_${n}`;
			const text = `${c.tool} ${JSON.stringify(c.args)}`;
			const id = this.push({ id: `a:resp${r}:p${j++}`, kind: "tool_call", text, toolName: c.tool, callId });
			return { id, callId };
		});
		calls.forEach((c, n) => {
			const { id, callId } = callIds[n];
			const result = this.push({ id: `r:${callId}`, kind: "tool_result", text: c.out, toolName: c.tool, callId, isError: c.isError });
			ids.calls.push({ call: id, result });
		});
		return ids;
	}
	/** Append everything not yet appended. */
	flush(host: TestHost): void {
		host.appendBlocks(this.blocks.slice(this.flushed));
		this.flushed = this.blocks.length;
	}
}

// ── content ─────────────────────────────────────────────────────────────────────────────────

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
function pySource(nFuncs = 12): string {
	const parts: string[] = ["import os", "import sys", ""];
	for (let i = 0; i < nFuncs; i++) {
		parts.push(`def func_${i}(a, b, c):`);
		parts.push(`    """Compute something useful for func ${i}."""`);
		parts.push(`    total = a + b + c`);
		for (let j = 0; j < 10; j++) parts.push(`    total += a * ${j} + b - ${j}`);
		parts.push(`    return total`);
		parts.push("");
	}
	return parts.join("\n");
}
const bash = (command: string, out: string): Call => ({ tool: "bash", args: { command }, out });
const read = (path: string, out: string, extra: Record<string, unknown> = {}): Call => ({ tool: "read", args: { path, ...extra }, out });
const edit = (path: string): Call => ({ tool: "edit", args: { path, oldText: "a", newText: "b" }, out: `Successfully replaced text in ${path}.` });

// ── host helpers ────────────────────────────────────────────────────────────────────────────

/** A TestHost that records every proposed transaction. */
class SpyHost extends TestHost {
	readonly txns: Array<{ ops: Op[]; res: TxnResult }> = [];
	override async propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		const res = await super.propose(txn);
		this.txns.push({ ops: txn.ops, res });
		return res;
	}
}

function setup(s: Session, opts: { protect?: number; budgetFactor?: number; budget?: number } = {}): SpyHost {
	const host = new SpyHost();
	s.flush(host);
	host.setProtect(opts.protect ?? 400);
	const live = host.stats().liveTokens;
	host.setBudget(opts.budget ?? Math.ceil(live / (opts.budgetFactor ?? 0.9)));
	return host;
}

const isFolded = (h: TestHost, id: string) => h.get(id)!.folded;
const isGrouped = (h: TestHost, id: string) => h.groups().some((g) => g.memberIds.includes(id));
const substOf = (h: TestHost, id: string) => h.truth.get(id)!.subst;
const indexOf = (h: TestHost, id: string) => h.blocks().findIndex((b) => b.id === id);
const pfi = (h: TestHost) => h.stats().protectedFromIndex;
const lowOf = (h: TestHost, low = KEEL_LITE_DEFAULTS.low) => low * h.stats().budget;
const highOf = (h: TestHost, high = KEEL_LITE_DEFAULTS.high) => high * h.stats().budget;

/** A plain SlopCode-ish session: a user ask then `n` steps of thinking + bash. */
function thinkBashSession(n: number, thinkChars = 2000, bashLines = 20): { s: Session; steps: StepIds[]; user: string } {
	const s = new Session();
	const user = s.user("Solve the problem.");
	const steps: StepIds[] = [];
	for (let i = 0; i < n; i++) steps.push(s.step({ think: thought(thinkChars, i), calls: [bash(`python run.py --case ${i}`, lines(bashLines, 40, `case${i}`))] }));
	return { s, steps, user };
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe("keel-lite · hysteresis", () => {
	it("proposes nothing while projected live tokens are under HIGH", async () => {
		const { s } = thinkBashSession(10);
		const host = setup(s, { budgetFactor: 0.8 }); // live = 80% of budget < 85%
		const c = new KeelLiteConductor();
		c.attach(host);
		await host.commitTurn();
		expect(host.txns).toHaveLength(0);
		expect(host.blocks().some((b) => b.folded)).toBe(false);
		expect(host.statusLog).toHaveLength(0);
	});

	it("an epoch folds thinking first, oldest first, and stops at LOW", async () => {
		const { s, steps } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelLiteConductor();
		c.attach(host);
		await host.commitTurn();

		expect(host.txns).toHaveLength(1);
		expect(host.stats().liveTokens).toBeLessThanOrEqual(lowOf(host));
		// Only thinking was touched — R1 alone reached LOW, so no bash result was trimmed.
		for (const st of steps) expect(isFolded(host, st.calls[0].result)).toBe(false);
		const eligibleThinking = steps.map((st) => st.think!).filter((id) => indexOf(host, id) < pfi(host));
		const foldedThinking = eligibleThinking.filter((id) => isFolded(host, id));
		expect(foldedThinking.length).toBeGreaterThan(0);
		// Oldest first: the folded ones are exactly a prefix of the eligible ones…
		expect(foldedThinking).toEqual(eligibleThinking.slice(0, foldedThinking.length));
		// …and it STOPPED at LOW rather than folding everything eligible.
		expect(foldedThinking.length).toBeLessThan(eligibleThinking.length);
		// Plain engine folds (no authored digest).
		for (const id of foldedThinking) expect(substOf(host, id)).toBeUndefined();
		expect(host.statusLog.at(-1)?.text).toMatch(/^epoch 1 · R1 · −/);
		expect(host.statusLog.at(-1)?.metrics).toMatchObject({ epochs: 1, rungs: "R1", groups_made: 0 });
	});

	it("the epoch lands synchronously inside the event dispatch (no deferred work)", () => {
		const { s } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		const pending = host.commitTurn(); // not awaited
		expect(host.blocks().some((b) => b.folded)).toBe(true);
		expect(host.stats().liveTokens).toBeLessThanOrEqual(lowOf(host));
		return pending;
	});

	it("proposes nothing between LOW and HIGH after an epoch, then epochs again past HIGH", async () => {
		const { s } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(host.txns).toHaveLength(1);

		// Grow into the band (above LOW, below HIGH): silence.
		while (host.stats().liveTokens < (lowOf(host) + highOf(host)) / 2) {
			s.step({ think: thought(400, 99), calls: [bash("ls", lines(4))] });
			s.flush(host);
			await host.commitTurn();
		}
		expect(host.stats().liveTokens).toBeGreaterThan(lowOf(host));
		expect(host.stats().liveTokens).toBeLessThan(highOf(host));
		expect(host.txns).toHaveLength(1);

		// Keep growing: the next epoch fires exactly when the projection crosses HIGH.
		for (let n = 0; n < 50 && host.txns.length === 1; n++) {
			s.step({ think: thought(1200, 7 + n), calls: [bash("ls", lines(10))] });
			s.flush(host);
			await host.commitTurn();
		}
		expect(host.txns).toHaveLength(2);
		const m = host.statusLog.at(-1)!.metrics!;
		expect(m.epochs).toBe(2);
		expect(Number(m.live_before)).toBeGreaterThanOrEqual(highOf(host));
		expect(host.stats().liveTokens).toBeLessThanOrEqual(lowOf(host));
	});

	it("honors constructor HIGH/LOW", async () => {
		const { s } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		new KeelLiteConductor({ high: 0.95, low: 0.5 }).attach(host);
		await host.commitTurn();
		expect(host.txns).toHaveLength(0); // 90% < 95%
		host.setBudget(Math.ceil(host.stats().liveTokens / 0.97)); // budget change wakes it
		await Promise.resolve();
		expect(host.txns).toHaveLength(1);
		expect(host.stats().liveTokens).toBeLessThanOrEqual(0.5 * host.stats().budget);
	});

	it("rejects an inverted or out-of-range band", () => {
		expect(() => new KeelLiteConductor({ high: 0.6, low: 0.7 })).toThrow(RangeError);
		expect(() => new KeelLiteConductor({ high: 1.2 })).toThrow(RangeError);
		expect(() => new KeelLiteConductor({ low: 0 })).toThrow(RangeError);
	});
});

describe("keel-lite · roots", () => {
	/** Briefing + guide + three spec paths (one read twice), then lots of work. */
	function rootedSession() {
		const s = new Session();
		const user = s.user("Read AGENT_BRIEFING.md and solve the SlopCode problems.");
		const briefing = s.step({ think: thought(600, 1), calls: [read("AGENT_BRIEFING.md", lines(60, 40, "brief"))] }).calls[0].result;
		const guide = s.step({ think: thought(600, 2), calls: [bash("python platform_client.py guide slopcode", lines(120, 60, "guide"))] }).calls[0].result;
		const specA1old = s.step({ think: thought(600, 3), calls: [read("spec_alpha_checkpoint_1.md", lines(40, 40, "specA1"))] }).calls[0].result;
		for (let i = 0; i < 4; i++) s.step({ think: thought(1600, 10 + i), calls: [bash(`pytest -k a${i}`, lines(30, 50, `a${i}`))] });
		const specA1 = s.step({ think: thought(600, 4), calls: [read("./spec_alpha_checkpoint_1.md", lines(40, 40, "specA1"))] }).calls[0].result;
		for (let i = 0; i < 4; i++) s.step({ think: thought(1600, 20 + i), calls: [bash(`pytest -k b${i}`, lines(30, 50, `b${i}`))] });
		const specA2 = s.step({ think: thought(600, 5), calls: [read("spec_alpha_checkpoint_2.md", lines(40, 40, "specA2"))] }).calls[0].result;
		for (let i = 0; i < 4; i++) s.step({ think: thought(1600, 30 + i), calls: [bash(`pytest -k c${i}`, lines(30, 50, `c${i}`))] });
		const specB1 = s.step({ think: thought(600, 6), calls: [read("spec_beta_checkpoint_1.md", lines(40, 40, "specB1"))] }).calls[0].result;
		for (let i = 0; i < 12; i++) s.step({ think: thought(1600, 40 + i), say: `Progress note ${i}.`, calls: [bash(`pytest -k d${i}`, lines(30, 50, `d${i}`))] });
		return { s, user, briefing, guide, specA1old, specA1, specA2, specB1 };
	}

	it("never touches user, system, the briefing, or the newest reads of the two newest spec paths", async () => {
		const r = rootedSession();
		const host = new SpyHost();
		host.truth.setSystemPrompt("You are a coding agent.", 8);
		r.s.flush(host);
		host.setProtect(300);
		host.setBudget(Math.ceil(host.stats().liveTokens / 4)); // brutal: every rung, groups included
		new KeelLiteConductor().attach(host);
		await host.commitTurn();

		const roots = [r.user, r.briefing, r.specA2, r.specB1];
		for (const id of roots) {
			expect(indexOf(host, id)).toBeLessThan(pfi(host)); // untouched by rule, not by the tail
			expect(isFolded(host, id)).toBe(false);
			expect(isGrouped(host, id)).toBe(false);
		}
		expect(isFolded(host, "sys:0")).toBe(false);
		for (const op of host.txns.flatMap((t) => t.ops)) {
			const ids = op.kind === "fold" || op.kind === "group" ? op.ids : op.kind === "replace" ? [op.id] : [];
			for (const id of roots) expect(ids).not.toContain(id);
			expect(ids).not.toContain("sys:0");
		}
		// The superseded duplicate (older read of the same path, spelled differently) was fair game…
		expect(isFolded(host, r.specA1old) || isGrouped(host, r.specA1old)).toBe(true);
		// …and so was the demoted (third-newest) spec path, but only at R6 — after R1–R5.
		expect(isFolded(host, r.specA1)).toBe(true);
		const rungs = String(host.statusLog.at(-1)?.metrics?.rungs);
		expect(rungs).toContain("R6");
		expect(rungs.indexOf("R6")).toBeGreaterThan(rungs.indexOf("R5"));
		// The guide output is exempt from R3's trim — it stays whole until R5 folds it.
		expect(substOf(host, r.guide)).toBeUndefined();
	});

	it("keeps a demoted spec read alive until every earlier rung is spent", async () => {
		const r = rootedSession();
		const host = setup(r.s, { protect: 300, budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(host.txns).toHaveLength(1);
		expect(isFolded(host, r.specA1)).toBe(false); // R1 sufficed; R6 never reached
	});
});

describe("keel-lite · stale reads (R2)", () => {
	it("folds a read that is later re-read or edited, and nothing fresher", async () => {
		const s = new Session();
		s.user("fix it");
		const readX = s.step({ calls: [read("src/x.ts", lines(50, 40, "x1"))] }).calls[0].result;
		const readY1 = s.step({ calls: [read("/work/src/y.ts", lines(50, 40, "y1"))] }).calls[0].result;
		s.step({ calls: [edit("/work/src/x.ts")] }); // x was rewritten after readX → stale
		const readY2 = s.step({ calls: [read("src/y.ts", lines(50, 40, "y2"))] }).calls[0].result; // y re-read → readY1 stale
		const readRanged = s.step({ calls: [read("src/z.ts", lines(50, 40, "z1"))] }).calls[0].result;
		s.step({ calls: [read("src/z.ts", lines(5, 40, "z2"), { offset: 10, limit: 5 })] }); // a RANGED re-read supersedes nothing
		for (let i = 0; i < 6; i++) s.step({ say: `note ${i}`, calls: [bash("true", "ok")] });
		const host = setup(s, { protect: 200, budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		await host.commitTurn();

		expect(isFolded(host, readX)).toBe(true);
		expect(isFolded(host, readY1)).toBe(true);
		expect(substOf(host, readX)).toBeUndefined(); // a plain fold
		expect(isFolded(host, readY2)).toBe(false);
		expect(isFolded(host, readRanged)).toBe(false);
		expect(host.statusLog.at(-1)?.metrics?.rungs).toBe("R2");
	});
});

describe("keel-lite · bash trim (R3)", () => {
	it("keeps 3 head + 12 tail lines around a marker, recoverably", async () => {
		const s = new Session();
		s.user("run the tests");
		const out = lines(100, 40, "t");
		const big = s.step({ calls: [bash("pytest -q", out)] }).calls[0].result;
		for (let i = 0; i < 6; i++) s.step({ say: `note ${i}`, calls: [bash("true", "ok")] });
		const host = setup(s, { protect: 200, budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		await host.commitTurn();

		const subst = substOf(host, big)!;
		expect(subst).toBeDefined();
		expect(hasOwnFoldTag(subst, big)).toBe(true); // the tag is the handle
		const body = subst.split("\n");
		const src = out.split("\n");
		expect(body[0]).toContain(src[0]); // first line, after the tag
		expect(body.slice(1, 3)).toEqual(src.slice(1, 3));
		expect(body[3]).toMatch(/^… 85 lines \/ ~\S+ tok elided — unfold to see full output …$/);
		expect(body.slice(4)).toEqual(src.slice(-12));
		expect(host.statusLog.at(-1)?.metrics?.rungs).toBe("R3");

		// Recoverable: the agent's own unfold by tag code restores the full output…
		const res = resolveUnfold(host.truth, [foldCode(big)]);
		expect(res.missing).toEqual([]);
		host.agentUnfold(big);
		expect(isFolded(host, big)).toBe(false);
		expect(host.textOf(big)).toBe(out);
		// …and keel-lite never fights that unfold on the next epoch.
		host.setBudget(Math.ceil(host.stats().liveTokens / 0.95));
		await host.commitTurn();
		expect(isFolded(host, big)).toBe(false);
	});

	it("caps kept lines and skips a trim that would not save 40%", async () => {
		const s = new Session();
		s.user("go");
		const wide = s.step({ calls: [bash("cat log", `${"W".repeat(3000)}\nshort`)] }).calls[0].result;
		const small = s.step({ calls: [bash("ls", lines(14, 60))] }).calls[0].result; // ≤ 15 lines, nothing long
		for (let i = 0; i < 6; i++) s.step({ say: `note ${i}`, calls: [bash("true", "ok")] });
		const host = setup(s, { protect: 150, budgetFactor: 0.9 });
		new KeelLiteConductor({ deepFoldMinTokens: 100_000 }).attach(host); // keep R5 out of the way
		await host.commitTurn();
		const w = substOf(host, wide)!;
		expect(w).toMatch(/W{200}…/);
		expect(w).not.toMatch(/W{201}/);
		expect(w).toContain("long lines clipped");
		expect(substOf(host, small)).toBeUndefined();
		expect(isFolded(host, small)).toBe(false);
	});
});

describe("keel-lite · reads (R4)", () => {
	it("skeletonizes a code read recoverably; folds a big non-code read", async () => {
		const s = new Session();
		s.user("go");
		const code = s.step({ calls: [read("src/big.py", pySource())] }).calls[0].result;
		const doc = s.step({ calls: [read("notes/README.md", lines(60, 40, "doc"))] }).calls[0].result;
		for (let i = 0; i < 6; i++) s.step({ say: `note ${i}`, calls: [bash("true", "ok")] });
		const host = setup(s, { protect: 150, budgetFactor: 1.3 }); // tight enough to need both reads
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		const sk = substOf(host, code)!;
		expect(sk).toContain("⟨code skeleton · src/big.py");
		expect(hasOwnFoldTag(sk, code)).toBe(true);
		expect(isFolded(host, doc)).toBe(true);
		expect(substOf(host, doc)).toBeUndefined();
		expect(host.statusLog.at(-1)?.metrics?.rungs).toBe("R4");
	});
});

describe("keel-lite · group stage (R7)", () => {
	it("groups the oldest whole steps into valid default-recap groups that never swallow a root", async () => {
		const s = new Session();
		const user = s.user("go");
		const brief = s.step({ calls: [read("AGENT_BRIEFING.md", lines(30))] }).calls[0].result;
		for (let i = 0; i < 20; i++) s.step({ say: `step ${i}`, calls: [edit(`src/f${i}.py`), bash(`python -c 'print(${i})'`, `${i}`)] });
		const spec = s.step({ calls: [read("spec_p_checkpoint_1.md", lines(30))] }).calls[0].result;
		for (let i = 0; i < 12; i++) s.step({ say: `later ${i}`, calls: [edit(`src/g${i}.py`)] });
		const host = setup(s, { protect: 200, budget: 0 });
		host.setBudget(Math.ceil(host.stats().liveTokens / 1.6)); // no per-block rung can get there
		new KeelLiteConductor().attach(host);
		await host.commitTurn();

		const groups = host.groups();
		expect(groups.length).toBeGreaterThan(1);
		const blocks = host.blocks();
		const at = (id: string) => blocks.findIndex((b) => b.id === id);
		for (const g of groups) {
			expect(g.by).toBe("auto");
			expect(g.summary).toBeUndefined(); // default tagged recap
			expect(g.folded).toBe(true);
			const idx = g.memberIds.map(at);
			for (let k = 1; k < idx.length; k++) expect(idx[k]).toBe(idx[k - 1] + 1); // contiguous
			expect(idx.at(-1)!).toBeLessThan(pfi(host));
			const members = idx.map((i) => blocks[i]);
			expect(snapToMessageAtoms(blocks, idx[0], idx.at(-1)!)).toEqual([idx[0], idx.at(-1)!]);
			const removable = collapsibleMessageKeys(members, true);
			for (const m of members) expect(removable.has(messageKey(m.id))).toBe(true); // collapses whole
			const steps = new Set(members.filter((m) => m.kind !== "tool_result").map((m) => messageKey(m.id)));
			expect(steps.size).toBeLessThanOrEqual(8);
			for (const root of [user, brief, spec]) expect(g.memberIds).not.toContain(root);
		}
		// Oldest first: the first group starts at the first step after the briefing.
		const firstGroup = groups[0].memberIds.map(at);
		expect(firstGroup[0]).toBe(at(brief) + 1);
		const m = host.statusLog.at(-1)?.metrics;
		expect(String(m?.rungs)).toContain("R7");
		expect(m?.groups_made).toBe(groups.length);
	});

	it("never groups across a held block", async () => {
		const s = new Session();
		s.user("go");
		let held = "";
		for (let i = 0; i < 20; i++) {
			const st = s.step({ say: `step ${i} ${"z".repeat(300)}`, calls: [edit(`src/f${i}.py`)] });
			if (i === 5) held = st.say!;
		}
		const host = setup(s, { protect: 200, budget: 0 });
		host.humanPin(held);
		host.setBudget(Math.ceil(host.stats().liveTokens / 1.6));
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(host.groups().length).toBeGreaterThan(0);
		expect(isGrouped(host, held)).toBe(false);
		expect(isFolded(host, held)).toBe(false);
	});
});

describe("keel-lite · held blocks", () => {
	it("skips pinned / human-unfolded blocks and still reaches LOW without counting them", async () => {
		const { s, steps } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		host.humanPin(steps[0].think!);
		host.humanUnfold(steps[1].think!);
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(isFolded(host, steps[0].think!)).toBe(false);
		expect(isFolded(host, steps[1].think!)).toBe(false);
		expect(isFolded(host, steps[2].think!)).toBe(true);
		expect(host.stats().liveTokens).toBeLessThanOrEqual(lowOf(host));
	});

	it("does not refold a block the agent unfolded, even across later epochs", async () => {
		const { s, steps } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		const t0 = steps[0].think!;
		expect(isFolded(host, t0)).toBe(true);
		host.agentUnfold(t0);
		for (let i = 0; i < 10; i++) {
			s.step({ think: thought(2000, 50 + i), calls: [bash("ls", lines(20))] });
			s.flush(host);
			await host.commitTurn();
		}
		expect(host.txns.length).toBeGreaterThan(1);
		expect(isFolded(host, t0)).toBe(false);
		for (const t of host.txns.slice(1)) for (const op of t.ops) if (op.kind === "fold" || op.kind === "group") expect(op.ids).not.toContain(t0);
	});
});

describe("keel-lite · monotonicity and robustness", () => {
	it("only ever adds fold/replace/group, and nothing it folded ever reopens", async () => {
		const { s } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		const everFolded = new Set<string>();
		for (let i = 0; i < 40; i++) {
			s.step({ think: thought(1500, 100 + i), say: i % 3 === 0 ? `note ${"n".repeat(1200)}` : undefined, calls: [bash(`run ${i}`, lines(25, 50, `r${i}`))] });
			s.flush(host);
			await host.commitTurn();
			for (const id of everFolded) expect(isFolded(host, id) || isGrouped(host, id)).toBe(true);
			for (const b of host.blocks()) if (b.folded) everFolded.add(b.id);
			expect(host.stats().liveTokens).toBeLessThanOrEqual(host.stats().budget);
		}
		const kinds = new Set(host.txns.flatMap((t) => t.ops.map((o) => o.kind)));
		for (const k of kinds) expect(["fold", "replace", "group"]).toContain(k);
		// A replace is only ever proposed on a block that was still live.
		const replaced = new Set<string>();
		for (const t of host.txns) for (const op of t.ops) if (op.kind === "replace") {
			expect(replaced.has(op.id)).toBe(false);
			replaced.add(op.id);
		}
		expect(host.txns.length).toBeGreaterThan(2);
		expect(host.txns.length).toBeLessThan(20); // batched epochs, not one edit per turn
	});

	it("does not record clamped ops as applied", async () => {
		class ClampHost extends SpyHost {
			override propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
				return Promise.resolve({ rev: this.truth.rev, results: txn.ops.map((op) => ({ op, applied: false, clamped: "stale" as const })) });
			}
		}
		const { s } = thinkBashSession(12);
		const host = new ClampHost();
		s.flush(host);
		host.setProtect(400);
		host.setBudget(Math.ceil(host.stats().liveTokens / 0.9));
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(host.statusLog.filter((x) => x.text?.startsWith("epoch"))).toHaveLength(0);
	});

	it("rebuilds from truth on resync and still deepens its own trims", async () => {
		const s = new Session();
		s.user("go");
		const big = s.step({ calls: [bash("pytest", lines(100, 40))] }).calls[0].result;
		// 200-token notes: under R5's threshold, so only `big` can be deepened per-block.
		for (let i = 0; i < 8; i++) s.step({ say: `note ${i} ${"n".repeat(790)}`, calls: [bash("true", "ok")] });
		const host = setup(s, { protect: 200, budgetFactor: 0.9 });
		const c = new KeelLiteConductor();
		c.attach(host);
		await host.commitTurn();
		expect(substOf(host, big)).toBeDefined(); // R3 trim

		await host.resync(); // forget in-memory state; re-adopt from truth
		expect(host.txns).toHaveLength(1); // under HIGH: resync alone proposes nothing

		host.setBudget(Math.ceil(host.stats().liveTokens / 0.99)); // now force deeper rungs
		await Promise.resolve();
		expect(isFolded(host, big)).toBe(true);
		expect(substOf(host, big)).toBeUndefined(); // deepened to a plain fold at R5
	});

	it("survives blocks vanishing from the host and never targets them again", async () => {
		/** A host whose view can drop blocks (as a structural rebuild / tree navigation would). */
		class VanishHost extends SpyHost {
			hidden = new Set<string>();
			override get(id: string) {
				return this.hidden.has(id) ? undefined : super.get(id);
			}
			override blocks() {
				return super.blocks().filter((b) => !this.hidden.has(b.id));
			}
		}
		const { s, steps } = thinkBashSession(12);
		const host = new VanishHost();
		s.flush(host);
		host.setProtect(400);
		host.setBudget(Math.ceil(host.stats().liveTokens / 0.9));
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(host.txns).toHaveLength(1);
		for (const id of [steps[0].think!, steps[0].calls[0].call, steps[0].calls[0].result]) host.hidden.add(id);
		await host.resync();
		const before = host.txns.length;
		for (let i = 0; i < 12; i++) {
			s.step({ think: thought(2000, 200 + i), calls: [bash("ls", lines(20))] });
			s.flush(host);
			await host.commitTurn();
		}
		expect(host.txns.length).toBeGreaterThan(before);
		for (const t of host.txns.slice(before))
			for (const op of t.ops) {
				const ids = op.kind === "fold" || op.kind === "group" ? op.ids : op.kind === "replace" ? [op.id] : [];
				for (const id of ids) expect(host.hidden.has(id)).toBe(false);
			}
	});

	it("reports saturation instead of proposing when nothing is eligible", async () => {
		const s = new Session();
		s.user("go");
		s.step({ calls: [read("AGENT_BRIEFING.md", lines(200))] });
		const host = setup(s, { protect: 200, budgetFactor: 0.9 });
		new KeelLiteConductor().attach(host);
		await host.commitTurn();
		expect(host.txns).toHaveLength(0);
		expect(host.statusLog.at(-1)?.text).toMatch(/^saturated/);
	});

	it("detach clears status and stops listening", async () => {
		const { s } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		const c = new KeelLiteConductor();
		c.attach(host);
		c.detach();
		await host.commitTurn();
		expect(host.txns).toHaveLength(0);
		expect(host.statusLog.at(-1)).toEqual({ text: null, metrics: undefined });
	});

	it("a throw while reconciling an applied epoch does not leave it stuck busy", async () => {
		const { s } = thinkBashSession(12);
		const host = setup(s, { budgetFactor: 0.9 });
		let failNext = true;
		const setStatus = host.setStatus.bind(host);
		host.setStatus = (text, metrics) => {
			if (failNext && text !== null) {
				failNext = false;
				throw new Error("status sink down");
			}
			setStatus(text, metrics);
		};
		new KeelLiteConductor().attach(host);
		// Epoch 1 applies, then its status publish throws (the host's event pump absorbs the rejection).
		await host.commitTurn();
		expect(failNext).toBe(false);
		expect(host.txns).toHaveLength(1);
		// Grow until keel-lite has to act again. A stuck `busy` would only ever set `pending`.
		for (let i = 0; i < 12 && host.txns.length < 2; i++) {
			s.step({ think: thought(2000, 900 + i), calls: [bash(`again ${i}`, lines(20, 40, `again${i}`))] });
			s.flush(host);
			await host.commitTurn();
			expect(host.stats().liveTokens).toBeLessThan(highOf(host));
		}
		expect(host.txns).toHaveLength(2);
		expect(String(host.statusLog.at(-1)?.text)).toMatch(/^epoch 2 /);
	});
});

describe("keel-lite · registry", () => {
	it("is registered in-process, collaborative, with its knobs from the environment", () => {
		const e = entryById("keel-lite");
		expect(e).toMatchObject({ id: "keel-lite", label: "Keel-lite", kind: "in-process", locks: [], holdWireUpToMs: 0, tailTokens: 0 });
		expect(e?.create?.()).toBeInstanceOf(KeelLiteConductor);
	});

	it("parses ACCORDION_KEEL_LITE_HIGH/LOW defensively", () => {
		const d = { high: 0.85, low: 0.65 };
		expect(keelLiteOptionsFromEnv({})).toEqual(d);
		expect(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_HIGH: "0.9", ACCORDION_KEEL_LITE_LOW: "0.5" })).toEqual({ high: 0.9, low: 0.5 });
		expect(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_LOW: "0.7" })).toEqual({ high: 0.85, low: 0.7 });
		expect(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_HIGH: "1", ACCORDION_KEEL_LITE_LOW: "abc" })).toEqual({ high: 1, low: 0.65 });
		expect(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_HIGH: "1.5", ACCORDION_KEEL_LITE_LOW: "-1" })).toEqual(d);
		expect(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_HIGH: "0.6" })).toEqual(d); // 0.65 ≥ 0.6 → both default
		expect(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_HIGH: "0.7", ACCORDION_KEEL_LITE_LOW: "0.7" })).toEqual(d);
		expect(() => new KeelLiteConductor(keelLiteOptionsFromEnv({ ACCORDION_KEEL_LITE_HIGH: "0.3", ACCORDION_KEEL_LITE_LOW: "0.2" }))).not.toThrow();
	});
});

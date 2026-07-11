import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "./parse";
import { AccordionStore } from "./store.svelte";
import { KeelConductor } from "$conductors";
import type { Conductor, ConductorView, CompletionRequest, CompletionResult } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";

/*
 * Keel conductor — Phase 1 (deterministic core, ADR 0017 §14).
 *
 * Driven END-TO-END through the real AccordionStore (NOT a MockHost): the store builds the
 * ConductorView, runs `conduct()`, and clamps every command to the host floor. A MockHost would
 * miss the store's `not-foldable` / `protected` clamps (project lesson), so every assertion here
 * goes through `store.attach(new KeelConductor())` / `store.applyCommands(...)`.
 *
 * Coverage:
 *   (a) golden determinism on the sample session;
 *   (b) budget invariant — adversarial synthetic views all end liveTokens ≤ budget via the floor;
 *   (c) reversibility — every emitted `replace` carries recoverable:true;
 *   (d) no protected/held block is ever folded;
 *   (e) determinism — two passes on the same view yield identical commands.
 */

const SAMPLE = readFileSync(
	fileURLToPath(new URL("../../../static/sample-session.jsonl", import.meta.url)),
	"utf8",
);

/** A synthetic block. Big text so token estimates are meaningful. */
function blk(i: number, kind: Block["kind"] = "text", tokens = 1000, extra: Partial<Block> = {}): Block {
	return {
		id: `m${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

/** Attach a fresh Keel and return the store, with a given budget/protect. */
function keelStore(blocks: Block[], budget: number, protect = 0): AccordionStore {
	const s = makeStore(blocks);
	s.setProtect(protect);
	s.setBudget(budget);
	s.attach(new KeelConductor());
	return s;
}

describe("Keel — golden determinism on the sample session", () => {
	it("folds the sample deterministically at default budget/protect", () => {
		const s = new AccordionStore(parse(SAMPLE));
		s.attach(new KeelConductor());

		const foldedIds = s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id).sort();

		// Sanity: the sample must actually exercise Keel.
		expect(s.blocks.length).toBeGreaterThan(900);
		expect(foldedIds.length).toBeGreaterThan(0);

		// Headline aggregates inline so a regression is visible in the diff.
		expect({
			blocks: s.blocks.length,
			foldedCount: s.foldedCount,
		}).toMatchInlineSnapshot(`
			{
			  "blocks": 982,
			  "foldedCount": 397,
			}
		`);

		// The exact folded-id set — external snapshot (the real golden).
		expect(foldedIds).toMatchSnapshot("keel-folded-ids");
	});

	it("respects the budget on the sample (live ≤ budget after folding)", () => {
		const s = new AccordionStore(parse(SAMPLE));
		s.attach(new KeelConductor());
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("is deterministic: a fresh Keel on the same sample folds identically", () => {
		const a = new AccordionStore(parse(SAMPLE));
		a.attach(new KeelConductor());
		const b = new AccordionStore(parse(SAMPLE));
		b.attach(new KeelConductor());
		const idsA = a.blocks.filter((x) => a.isFolded(x)).map((x) => x.id).sort();
		const idsB = b.blocks.filter((x) => b.isFolded(x)).map((x) => x.id).sort();
		expect(idsA).toEqual(idsB);
	});
});

describe("Keel — budget invariant via the hard-cap floor", () => {
	it("one huge block: still ends ≤ budget", () => {
		// A single 50k block dwarfs the budget; the floor must force it down.
		const s = keelStore([blk(0, "user", 200), blk(1, "tool_result", 50_000)], 5_000, 0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("all-code reads: ends ≤ budget (skeleton + floor)", () => {
		const code = Array.from({ length: 12 }, (_, i) =>
			blk(i, "tool_result", 4_000, {
				toolName: "read",
				callId: `c${i}`,
				text:
					`function foo${i}(a: number, b: number) {\n` +
					Array.from({ length: 400 }, (_, k) => `  const v${k} = a + b + ${k};`).join("\n") +
					"\n  return a + b;\n}\n",
			}),
		);
		// Pair each result with a tool_call so the classifier can recover the path.
		const calls = code.map((b, i) =>
			blk(100 + i, "tool_call", 5, { callId: `c${i}`, toolName: "read", text: `read {"file_path":"src/foo${i}.ts"}` }),
		);
		const blocks: Block[] = [blk(0, "user", 100)];
		for (let i = 0; i < code.length; i++) {
			blocks.push(calls[i], code[i]);
		}
		const s = keelStore(blocks, 8_000, 0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("tail bigger than budget: floor still cannot exceed budget for foldable content", () => {
		// 20 blocks of 2k each = 40k; budget 6k. Even with a protected tail the floor drives the
		// foldable region to fit. (Protected blocks can't be folded — so we keep protect small.)
		const s = keelStore(
			Array.from({ length: 20 }, (_, i) => blk(i, i === 0 ? "user" : "text", 2_000)),
			6_000,
			2_000,
		);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("all-prose long blocks: ends ≤ budget (trim + floor)", () => {
		const s = keelStore(
			Array.from({ length: 15 }, (_, i) =>
				blk(i, i === 0 ? "user" : "text", 3_000, {
					text: Array.from({ length: 300 }, (_, k) => `Sentence ${k} discussing topic number ${i}-${k} at length.`).join("\n"),
				}),
			),
			7_000,
			0,
		);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});
});

describe("Keel — reversibility", () => {
	it("code reads are substituted with a RECOVERABLE skeleton (FOLDED tag present)", () => {
		// 6 code-file reads paired with read calls; budget forces compression.
		const code = Array.from({ length: 6 }, (_, i) =>
			blk(2 * i + 2, "tool_result", 4_000, {
				toolName: "read",
				callId: `c${i}`,
				text:
					`export function bar${i}() {\n` +
					Array.from({ length: 400 }, (_, k) => `  doThing(${k});`).join("\n") +
					"\n}\n",
			}),
		);
		const calls = Array.from({ length: 6 }, (_, i) =>
			blk(2 * i + 1, "tool_call", 5, { callId: `c${i}`, toolName: "read", text: `read {"file_path":"src/bar${i}.ts"}` }),
		);
		const blocks: Block[] = [blk(0, "user", 100)];
		for (let i = 0; i < 6; i++) blocks.push(calls[i], code[i]);

		const s = keelStore(blocks, 8_000, 0);

		// At least one code read was substituted with a skeleton — `subst` carries the body and the
		// rendered digest carries the engine's `{#code FOLDED}` recovery tag (recoverable → the agent
		// can unfold/recall the full source). This is the host-side proof of recoverable:true.
		const skeletoned = s.blocks.filter((b) => b.kind === "tool_result" && b.subst !== undefined);
		expect(skeletoned.length).toBeGreaterThan(0);
		for (const b of skeletoned) {
			expect(b.subst).toContain("code skeleton"); // the skeleton header (a real substitution)
			expect(s.digestOf(b)).toContain("FOLDED"); // recovery tag baked by the host → reversible
		}
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});
});

describe("Keel — never folds protected or held blocks", () => {
	it("a protected-tail block is never folded", () => {
		const s = keelStore(
			Array.from({ length: 30 }, (_, i) => blk(i, i === 0 ? "user" : "text", 2_000)),
			6_000,
			8_000, // a real protected tail
		);
		const pf = s.protectedFromIndex;
		s.blocks.forEach((b, i) => {
			if (i >= pf) expect(s.isFolded(b)).toBe(false);
		});
	});

	it("a human-held (pinned) block is never folded", () => {
		const s = makeStore(Array.from({ length: 20 }, (_, i) => blk(i, i === 0 ? "user" : "text", 2_000)));
		s.setProtect(0);
		s.setBudget(6_000);
		s.pin("m5:p0"); // human pins a mid-session block
		s.attach(new KeelConductor());
		expect(s.isFolded(s.get("m5:p0")!)).toBe(false);
		expect(s.get("m5:p0")!.override).toBe("pinned");
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget); // floor still meets budget around the pin
	});
});

// ── adversarial-review regression cases (blockers 1–3, design 4 & 6) ─────────

/** Build a pure synthetic ConductorView (no store) for direct conduct() inspection. */
function makeView(
	blocks: ConductorView["blocks"],
	budget: number,
	opts: Partial<Pick<ConductorView, "contextWindow" | "liveTokens" | "protectedFromIndex" | "protectTokens">> = {},
): ConductorView {
	const liveTokens = opts.liveTokens ?? blocks.reduce((n, b) => n + b.tokens, 0);
	return {
		blocks,
		budget,
		contextWindow: opts.contextWindow ?? null,
		liveTokens,
		protectedFromIndex: opts.protectedFromIndex ?? blocks.length,
		protectTokens: opts.protectTokens ?? 0,
	};
}

/** A synthetic ViewBlock with realistic foldedTokens for a small-digest text block. */
function vblk(i: number, tokens: number, extra: Partial<ConductorView["blocks"][number]> = {}): ConductorView["blocks"][number] {
	return {
		id: `m${i}:p0`,
		kind: "text",
		turn: i + 1,
		order: i,
		tokens,
		foldedTokens: 40, // realistic digest cost for a text block
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		text: `block ${i} content describing topic ${i} at some length`,
		...extra,
	};
}

/** Collect every id that appears in a fold/replace command, group-member command, and drop command. */
function dispositions(cmds: ReturnType<KeelConductor["conduct"]>): {
	foldReplace: string[];
	groupMembers: string[];
	dropMembers: string[];
} {
	const foldReplace: string[] = [];
	const groupMembers: string[] = [];
	const dropMembers: string[] = [];
	for (const c of cmds ?? []) {
		if (c.kind === "fold") foldReplace.push(...c.ids);
		else if (c.kind === "replace") foldReplace.push(c.id);
		else if (c.kind === "group") {
			if (c.digest === null || c.digest === "") dropMembers.push(...c.ids);
			else groupMembers.push(...c.ids);
		}
	}
	return { foldReplace, groupMembers, dropMembers };
}

describe("Keel — floor residue (blocker 1): folded digest residue still over cap forces group/drop", () => {
	it("ends liveTokens ≤ budget AND fires a group or drop when Σ foldedTokens > cap", () => {
		// 60 text blocks of 1k each = 60k; cap 1k. Even fully folded (≈40 tok each → ~2.4k residue)
		// the sum of digests exceeds the 1k cap, so the floor MUST advance past stage-1 force-folds
		// into stage-2 group / stage-3 drop. Block 0 is a user root (non-foldable).
		const blocks: Block[] = [blk(0, "user", 200)];
		for (let i = 1; i < 60; i++) blocks.push(blk(i, "text", 1_000));
		const s = keelStore(blocks, 1_000, 0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		// A group (or drop) actually fired — there is at least one folded conductor group.
		const groups = s.groups.filter((g) => g.by === "auto" || g.by === "conductor");
		expect(groups.length).toBeGreaterThan(0);
		// Zero clamp reports on this adversarial view (groups snapped to valid contiguous runs).
		expect(s.lastReports.filter((r) => r.reason !== "noop")).toEqual([]);
	});

	it("direct conduct(): a deep-residue view emits a group/drop command", () => {
		const blocks = Array.from({ length: 50 }, (_, i) =>
			i === 0 ? vblk(0, 200, { kind: "user", foldedTokens: 200 }) : vblk(i, 1_000),
		);
		const view = makeView(blocks, 1_000);
		const cmds = new KeelConductor().conduct(view);
		const hasGroupOrDrop = (cmds ?? []).some((c) => c.kind === "group");
		expect(hasGroupOrDrop).toBe(true);
	});
});

describe("Keel — single disposition (blocker 2): no id carries two commands", () => {
	it("fold/replace ids, group-member ids and drop ids are pairwise disjoint", () => {
		// A residue-heavy view that drives stage-1 folds AND stage-2/3 grouping — exactly the case
		// where the OLD floor would emit the same id in both a fold and a group.
		const cases: ConductorView[] = [
			// (a) deep prose residue
			makeView(
				Array.from({ length: 50 }, (_, i) =>
					i === 0 ? vblk(0, 200, { kind: "user", foldedTokens: 200 }) : vblk(i, 1_000),
				),
				1_000,
			),
			// (b) a mix of big + small so stage-1 folds the big ones and stage-2 sweeps the rest
			makeView(
				Array.from({ length: 40 }, (_, i) =>
					i === 0
						? vblk(0, 200, { kind: "user", foldedTokens: 200 })
						: vblk(i, i % 2 === 0 ? 5_000 : 800),
				),
				2_000,
			),
			// (c) tiny cap forcing drop
			makeView(
				Array.from({ length: 30 }, (_, i) =>
					i === 0 ? vblk(0, 200, { kind: "user", foldedTokens: 200 }) : vblk(i, 2_000),
				),
				500,
			),
		];
		for (const view of cases) {
			const cmds = new KeelConductor().conduct(view);
			const { foldReplace, groupMembers, dropMembers } = dispositions(cmds);
			const seen = new Set<string>();
			for (const id of [...foldReplace, ...groupMembers, ...dropMembers]) {
				expect(seen.has(id), `id ${id} appears in more than one disposition`).toBe(false);
				seen.add(id);
			}
		}
	});

	it("store applies the plan with zero non-noop clamps across the adversarial views", () => {
		// Same shapes, driven END-TO-END so the host's whole-message snap + clamp gate would catch
		// any double-command or orphaned-pair the conductor emitted.
		const shapes: Array<[Block[], number]> = [
			[
				[blk(0, "user", 200), ...Array.from({ length: 40 }, (_, i) => blk(i + 1, "text", 1_500))],
				2_000,
			],
			[
				[
					blk(0, "user", 200),
					...Array.from({ length: 30 }, (_, i) => blk(i + 1, i % 2 === 0 ? "tool_result" : "text", i % 2 === 0 ? 5_000 : 900, { toolName: "x" })),
				],
				3_000,
			],
		];
		for (const [blocks, budget] of shapes) {
			const s = keelStore(blocks, budget, 0);
			expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
			expect(s.lastReports.filter((r) => r.reason !== "noop")).toEqual([]);
		}
	});
});

describe("Keel — conservative group head (blocker 3): all-prose forced deep into grouping ≤ cap", () => {
	it("ends ≤ budget even when grouping is the only lever (no big single block to fold)", () => {
		// 80 uniform prose blocks; their digests alone (~40 tok × 79 ≈ 3.1k) exceed the 800 cap, so
		// the floor groups deeply. The conservative head estimate must not under-count and terminate
		// above cap — assert the store's real liveTokens lands ≤ budget.
		const blocks: Block[] = [blk(0, "user", 100)];
		for (let i = 1; i < 80; i++) {
			blocks.push(
				blk(i, "text", 1_200, {
					text: Array.from({ length: 50 }, (_, k) => `Line ${k} of block ${i} with content.`).join("\n"),
				}),
			);
		}
		const s = keelStore(blocks, 800, 0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});
});

describe("Keel — honest budget invariant (design 4): protected tail > cap announces over-budget", () => {
	it("returns without falsely claiming ≤ cap and surfaces an over-budget status", () => {
		// A protected tail that ALONE exceeds the budget: 5 protected blocks of 3k = 15k, budget 6k.
		// Protection is host-absolute, so Keel cannot fold below 15k. It must fold everything it can
		// and announce the overage rather than claim it met budget.
		const blocks: Block[] = [blk(0, "user", 200)];
		for (let i = 1; i < 12; i++) blocks.push(blk(i, "text", 3_000));
		// protect ~15k so the newest ~5 blocks (15k) are the protected tail.
		const s = keelStore(blocks, 6_000, 15_000);
		// Honest: liveTokens is NOT ≤ budget here (the protected tail alone is over) — and Keel does
		// not pretend otherwise. The protected tail is genuinely larger than the budget.
		const pf = s.protectedFromIndex;
		let protTokens = 0;
		s.blocks.forEach((b, i) => {
			if (i >= pf) protTokens += b.tokens;
		});
		expect(protTokens).toBeGreaterThan(s.budget);
		expect(s.liveTokens).toBeGreaterThan(s.budget); // honestly over — no false ≤budget claim
		// And a status was surfaced naming the over-budget cause.
		expect(s.conductorStatus.text).toContain("OVER BUDGET");
		expect(s.conductorStatus.metrics.over_budget).toBe(true);
	});
});

describe("Keel — multi-pass determinism (design 6): unchanged view ⇒ identical commands, no drift", () => {
	it("appending blocks across passes on one instance never drifts for an unchanged view", () => {
		const keel = new KeelConductor();
		const baseBlocks = Array.from({ length: 40 }, (_, i) =>
			i === 0 ? vblk(0, 200, { kind: "user", foldedTokens: 200 }) : vblk(i, 1_500),
		);
		const view = makeView(baseBlocks, 3_000);

		// Pass 1 establishes a plan; passes 2 and 3 on the SAME view must be byte-identical (HOLD).
		const p1 = JSON.stringify(keel.conduct(view));
		const p2 = JSON.stringify(keel.conduct(view));
		const p3 = JSON.stringify(keel.conduct(view));
		expect(p2).toEqual(p1);
		expect(p3).toEqual(p1);

		// Now grow the conversation (new blocks appended) — a NEW view — then settle back: re-running
		// the grown view twice must again be identical (no cross-pass instance drift).
		const grown = makeView(
			[...baseBlocks, vblk(40, 1_500), vblk(41, 1_500)],
			3_000,
		);
		const g1 = JSON.stringify(keel.conduct(grown));
		const g2 = JSON.stringify(keel.conduct(grown));
		expect(g2).toEqual(g1);

		// A fresh instance on the grown view yields the SAME plan as the grown instance (no hidden
		// state advantage — pure function of view + pruned memory).
		const fresh = JSON.stringify(new KeelConductor().conduct(grown));
		expect(fresh).toEqual(g1);
	});
});

describe("Keel — pass determinism", () => {
	it("running conduct twice on the same view yields identical commands", () => {
		// Build a pure ConductorView directly (no store) so the view object is byte-stable across
		// both calls — this isolates `conduct()`'s determinism from any store-side fold state.
		const blocks: ConductorView["blocks"] = Array.from({ length: 20 }, (_, i) => ({
			id: `m${i}:p0`,
			kind: i === 0 ? "user" : "text",
			turn: i + 1,
			order: i,
			tokens: 2_000,
			foldedTokens: 30,
			held: false,
			folded: false,
			protected: false,
			grouped: false,
			text: `block ${i} content with some words about topic ${i}`,
		}));
		const view: ConductorView = {
			blocks,
			budget: 6_000,
			contextWindow: null,
			liveTokens: 40_000,
			protectedFromIndex: blocks.length,
			protectTokens: 0,
		};
		const a = JSON.stringify(new KeelConductor().conduct(view));
		const b = JSON.stringify(new KeelConductor().conduct(view));
		expect(a).toEqual(b);
		// And the same instance, called twice on the identical view, HOLDS to the same plan.
		const keel = new KeelConductor();
		const c1 = JSON.stringify(keel.conduct(view));
		const c2 = JSON.stringify(keel.conduct(view));
		expect(c2).toEqual(c1);
	});

	it("is collaborative (no locks)", () => {
		const keel: Conductor = new KeelConductor();
		expect(keel.locks).toBeUndefined();
		expect(keel.id).toBe("keel");
		expect(keel.label).toBe("Keel");
	});
});

// ── Phase-2 budget invariant END-TO-END (the gap the MockHost tests never closed) ───────────────
//
// Every Phase-2 async test asserts command SHAPE via a MockHost; none assert TOKENS through the real
// host. The blocker was a cache-hit deep-zone LLM digest applied with a cost HIDDEN from the hard-cap
// floor → the emitted plan could exceed cap (reviewer reproduced 12180 vs cap 4000). This test drives
// the WHOLE loop through AccordionStore with a real host + a stub completer that returns a LARGE digest
// (600+ tokens), forcing a deep zone, and asserts liveTokens ≤ budget AFTER the rerun lands.
describe("Keel Phase 2 — budget invariant holds after the LLM deep digest is applied (end-to-end)", () => {
	/** A controllable deferred promise. */
	function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((res) => (resolve = res));
		return { promise, resolve };
	}

	it("a 600+ token deep digest does not push liveTokens over budget", async () => {
		// 60 prose blocks of 500 tok each (block 0 a user root) → ~30k live, budget 4k. Each block is
		// BELOW the trim/skeleton thresholds (MIN_TRIM_TOKENS=600, MIN_SKELETON_TOKENS=1500), so the
		// ladder skips L1/L2 and these fall through to digestLevel — populating the deep zone. Pass-1
		// folds the cold region deterministically and launches an LLM completion for the deep zone.
		const blocks: Block[] = [blk(0, "user", 200)];
		for (let i = 1; i < 60; i++) blocks.push(blk(i, "text", 500));

		const s = makeStore(blocks);
		s.setProtect(0);
		s.setBudget(4_000);

		// A LARGE digest: ~3200 chars → ~800 tokens. If this cost were hidden from the floor (the
		// blocker), collapsing the deep zone into a group carrying this text would blow past the 4k cap.
		const BIG_DIGEST =
			"## User messages\n(none)\n\n## Key facts\n" +
			Array.from({ length: 80 }, (_, i) => `- src/module_${i}.ts exposes fn_${i}(arg=${i})`).join("\n") +
			"\n\n## Summary\nA long cold region covering many modules and decisions.";
		expect(Math.ceil(BIG_DIGEST.length / 4)).toBeGreaterThan(600); // genuinely large

		const d = deferred<CompletionResult>();
		let completeCalls = 0;
		// Inject the completer the host exposes via can("complete")/complete().
		s.completer = (_req: CompletionRequest): Promise<CompletionResult> => {
			completeCalls++;
			return d.promise;
		};

		// Attach → first refold runs conduct(): cold region folded, deep zone launched.
		s.attach(new KeelConductor());
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget); // pass-1 (deterministic) already ≤ budget
		expect(completeCalls).toBe(1); // the deep-zone completion fired

		// Resolve the LLM completion with the large digest. The conductor stashes it and calls
		// host.requestRerun(), which the store schedules on a microtask → a fresh conduct() pass.
		d.resolve({ text: BIG_DIGEST, model: "test-model" });
		// Flush microtasks (requestRerun schedules via queueMicrotask) AND any further turns.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// THE INVARIANT: even after the large LLM digest is applied, the floor held the hard cap.
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		// And no clamp report fired (the plan was wire-valid: single disposition, contiguous groups).
		expect(s.lastReports.filter((r) => r.reason !== "noop")).toEqual([]);
	});
});

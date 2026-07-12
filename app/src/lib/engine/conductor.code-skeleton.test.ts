/*
 * conductor.code-skeleton.test.ts — behavioural tests for CodeSkeletonConductor (ADR 0016).
 *
 * Two layers (mirroring the other conductor suites):
 *   A. Direct `conduct()` calls with synthetic views — classification, the replace command
 *      shape, the generic-fold fallback.
 *   B. End-to-end through AccordionStore — the part that matters most, because only the real
 *      engine applies the host clamps a MockHost would miss (protected tail, not-foldable,
 *      human-override) AND the `recoverable` tag-baking + the unfold/recall round-trip. The
 *      headline claim — "a skeleton is a RECOVERABLE fold" — is proved here through the actual
 *      `resolveUnfold` wire resolver the live agent uses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodeSkeletonConductor } from "$conductors/code-skeleton/code-skeleton";
import { IN_PROCESS_CONDUCTORS } from "$conductors";
import type { Command, ConductorView, ViewBlock } from "$conductors/contract";
import { AccordionStore } from "./store.svelte";
import { parse } from "./parse";
import { foldCode } from "./digest";
import type { Block, ParsedSession } from "./types";
import { resolveUnfold } from "../live/plan";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A sizeable, deterministic Python file: 4 classes × 4 methods, fat bodies. Its method
 *  SIGNATURES (method_c_m) must survive skeletonization; its body locals (body_local_*) must
 *  not. ~250 lines / ~2.7k tokens — comfortably past MIN_SKELETON_TOKENS (1500). */
function bigPython(): string {
	const lines: string[] = ["import math", "from typing import Dict, List", "", "API_CONSTANT = 42", ""];
	for (let c = 0; c < 4; c++) {
		lines.push(`class ArsenalModule${c}:`);
		lines.push(`    """Module ${c} — public surface kept, bodies elided."""`);
		for (let m = 0; m < 4; m++) {
			lines.push(`    def method_${c}_${m}(self, x: int, y: int) -> int:`);
			lines.push(`        """Compute thing ${c}.${m}."""`);
			for (let b = 0; b < 12; b++) {
				lines.push(`        body_local_${c}_${m}_${b} = x * ${b} + y  # filler body line`);
			}
			lines.push(`        return body_local_${c}_${m}_0`);
			lines.push("");
		}
	}
	return lines.join("\n");
}

/** A sizeable markdown README — prose, NOT code. Must never be skeletonized. */
function bigMarkdown(): string {
	const lines: string[] = ["# Arsenal Bot", "", "Strategy notes for the battleship variant.", ""];
	for (let i = 0; i < 80; i++) {
		lines.push(`## Section ${i}`, "");
		lines.push(`This section describes behaviour number ${i} in plain prose. `.repeat(4));
		lines.push("");
	}
	return lines.join("\n");
}

const PY = bigPython();
const MD = bigMarkdown();
const PY_TOKENS = Math.ceil(PY.length / 4);
const MD_TOKENS = Math.ceil(MD.length / 4);

// ── Synthetic-view helpers (direct conduct()) ──────────────────────────────────

function vb(
	id: string,
	kind: ViewBlock["kind"],
	order: number,
	tokens: number,
	foldedTokens: number,
	opts: { held?: boolean; protected?: boolean; grouped?: boolean; callId?: string; text?: string; toolName?: string; isError?: boolean } = {},
): ViewBlock {
	return {
		id,
		kind,
		turn: order + 1,
		order,
		tokens,
		foldedTokens,
		held: opts.held ?? false,
		folded: false,
		protected: opts.protected ?? false,
		grouped: opts.grouped ?? false,
		callId: opts.callId,
		text: opts.text,
		toolName: opts.toolName,
		isError: opts.isError,
	};
}

function makeView(blocks: ViewBlock[], budget: number, liveTokens: number): ConductorView {
	const pfi = blocks.findIndex((b) => b.protected);
	return { blocks, budget, liveTokens, contextWindow: null, protectedFromIndex: pfi < 0 ? blocks.length : pfi, protectTokens: 0 };
}

function replaceOf(cmds: Command[], id: string): (Command & { kind: "replace" }) | undefined {
	return cmds.find((c): c is Command & { kind: "replace" } => c.kind === "replace" && c.id === id);
}

function foldIdsOf(cmds: Command[]): Set<string> {
	const f = cmds.find((c): c is Command & { kind: "fold" } => c.kind === "fold");
	return new Set(f?.ids ?? []);
}

// ── Store helpers (end-to-end) ─────────────────────────────────────────────────

/** Build Blocks with order/turn assigned by array index; fills the reactive defaults. */
function seq(items: Array<Partial<Block> & Pick<Block, "kind">>): Block[] {
	return items.map((it, i) => ({
		id: it.id ?? `m${i}:p0`,
		kind: it.kind,
		turn: it.turn ?? i + 1,
		order: i,
		text: it.text ?? "",
		tokens: it.tokens ?? Math.max(1, Math.ceil((it.text ?? "").length / 4)),
		override: it.override ?? null,
		autoFolded: false,
		by: it.by ?? null,
		toolName: it.toolName,
		callId: it.callId,
		isError: it.isError,
	}));
}

function makeStore(blocks: Block[], budget: number, protect: number): AccordionStore {
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setProtect(protect);
	s.setBudget(budget);
	return s;
}

/** A user ask + a read(call,result) of `code` at `path` + a fat protected tail. The result id
 *  is durable (`r:<callId>`) so the wire resolver can match it. */
function codeReadSession(path: string, code: string, callId = "c1"): Block[] {
	return seq([
		{ kind: "user", text: "please work on the bot", tokens: 40 },
		{ kind: "tool_call", toolName: "read", callId, text: `read {"path":${JSON.stringify(path)}}`, tokens: 20 },
		{ kind: "tool_result", id: `r:${callId}`, toolName: "read", callId, text: code, tokens: Math.ceil(code.length / 4) },
		{ kind: "text", text: "current reasoning ".repeat(600), tokens: 3000 }, // fat tail
	]);
}

// ── 1. Registry & declaration ──────────────────────────────────────────────────

describe("CodeSkeletonConductor — registry & declaration", () => {
	it("id and label are stable", () => {
		const c = new CodeSkeletonConductor();
		expect(c.id).toBe("code-skeleton");
		expect(c.label).toBe("Code skeleton");
	});

	it("is collaborative — the registry declares no involvement locks (no consent gate)", () => {
		const entry = IN_PROCESS_CONDUCTORS.find((c) => c.id === "code-skeleton");
		expect(entry).toBeDefined();
		expect(entry!.locks).toBeUndefined();
	});
});

// ── 2. Direct conduct() ────────────────────────────────────────────────────────

describe("CodeSkeletonConductor — direct conduct()", () => {
	it("returns [] when under budget (raw)", () => {
		const view = makeView([vb("r:c1", "tool_result", 0, PY_TOKENS, 30, { toolName: "read", callId: "c1", text: PY })], 100_000, 5_000);
		expect(new CodeSkeletonConductor().conduct(view)).toEqual([]);
	});

	it("skeletonizes a large code read with a RECOVERABLE replace carrying signatures, not bodies", () => {
		const view = makeView(
			[
				vb("call:c1", "tool_call", 0, 20, 20, { toolName: "read", callId: "c1", text: `read {"path":"arsenal.py"}` }),
				vb("r:c1", "tool_result", 1, PY_TOKENS, 30, { toolName: "read", callId: "c1", text: PY }),
				vb("tail", "text", 2, 3000, 100, { protected: true }),
			],
			4_000,
			PY_TOKENS + 3_020,
		);
		const cmds = new CodeSkeletonConductor().conduct(view);
		const rep = replaceOf(cmds, "r:c1");
		expect(rep, "the code read should be replaced with a skeleton").toBeDefined();
		expect(rep!.recoverable, "skeletons must be agent-recoverable").toBe(true);
		expect(rep!.content).toContain("code skeleton"); // the header
		expect(rep!.content).toContain("class ArsenalModule0"); // a kept signature
		expect(rep!.content).toContain("def method_3_3"); // a kept signature
		expect(rep!.content).not.toContain("body_local_0_0_5"); // an elided body local
		// the tool_call is never touched (not wire-foldable)
		expect(replaceOf(cmds, "call:c1")).toBeUndefined();
		expect(foldIdsOf(cmds).has("call:c1")).toBe(false);
	});

	it("does NOT skeletonize a markdown read (rejected by the classifier)", () => {
		const view = makeView(
			[
				vb("call:c1", "tool_call", 0, 20, 20, { toolName: "read", callId: "c1", text: `read {"path":"README.md"}` }),
				vb("r:c1", "tool_result", 1, MD_TOKENS, 30, { toolName: "read", callId: "c1", text: MD }),
				vb("tail", "text", 2, 3000, 100, { protected: true }),
			],
			2_000,
			MD_TOKENS + 3_020,
		);
		const cmds = new CodeSkeletonConductor().conduct(view);
		expect(cmds.filter((c) => c.kind === "replace").length, "markdown is never skeletonized").toBe(0);
	});

	it("falls back to a generic fold to meet budget when there's no code (Tier 2)", () => {
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1000, 50));
		const view = makeView(blocks, 5_000, 10_000);
		const cmds = new CodeSkeletonConductor().conduct(view);
		// no replaces (no code), a single fold that brings projected live ≤ budget
		expect(cmds.filter((c) => c.kind === "replace").length).toBe(0);
		const folded = foldIdsOf(cmds);
		let live = view.liveTokens;
		for (const b of view.blocks) if (folded.has(b.id)) live += b.foldedTokens - b.tokens;
		expect(live).toBeLessThanOrEqual(view.budget);
	});
});

// ── 3. End-to-end through AccordionStore ───────────────────────────────────────

describe("CodeSkeletonConductor — end-to-end skeletonization", () => {
	it("replaces a code read with a tagged skeleton, saves tokens, meets budget, no clamps", () => {
		const s = makeStore(codeReadSession("arsenal_chaos_client.py", PY), 4_000, 2_500);
		s.attach(new CodeSkeletonConductor());

		const rb = s.get("r:c1")!;
		expect(s.isFolded(rb), "code read is folded").toBe(true);

		const shown = s.digestOf(rb);
		// The recoverable handle the agent receives — exactly `foldCode(id)`, what resolveUnfold matches.
		expect(shown.startsWith(`{#${foldCode("r:c1")} FOLDED}`), "skeleton carries the {#code FOLDED} tag").toBe(true);
		expect(shown).toContain("code skeleton");
		expect(shown).toContain("class ArsenalModule0"); // signatures survive
		expect(shown).not.toContain("body_local_2_2_2"); // bodies elided

		expect(s.effTokens(rb)).toBeLessThan(rb.tokens); // budget reflects the saving
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		expect(s.lastReports, "no clamps — replace on a foldable tool_result is always valid").toEqual([]);
	});

	it("is reversible: store.unfold('agent') restores the full original source", () => {
		const s = makeStore(codeReadSession("arsenal_chaos_client.py", PY), 4_000, 2_500);
		s.attach(new CodeSkeletonConductor());
		const rb = s.get("r:c1")!;
		expect(s.isFolded(rb)).toBe(true);

		s.unfold("r:c1", "agent");
		expect(s.isFolded(rb)).toBe(false);
		expect(rb.subst, "the skeleton substitution is cleared on unfold").toBeUndefined();
		expect(s.effTokens(rb)).toBe(rb.tokens); // full content back
	});

	it("is reversible through the live wire resolver: resolveUnfold(code) restores it (the agent path)", () => {
		const s = makeStore(codeReadSession("arsenal_chaos_client.py", PY), 4_000, 2_500);
		s.attach(new CodeSkeletonConductor());
		const code = foldCode("r:c1");

		const { restored, missing } = resolveUnfold(s, [code]);
		expect(missing, "the code the agent copied from the tag resolves").toEqual([]);
		expect(restored.some((r) => r.ids.includes("r:c1"))).toBe(true);
		expect(s.isFolded(s.get("r:c1")!), "agent unfolded the skeleton back to full source").toBe(false);
	});

	it("respects a human pin — a held code read is never skeletonized (collaborative)", () => {
		const s = makeStore(codeReadSession("arsenal_chaos_client.py", PY), 4_000, 2_500);
		s.pin("r:c1"); // human keeps it open
		s.attach(new CodeSkeletonConductor());
		const rb = s.get("r:c1")!;
		expect(s.isFolded(rb), "pinned block stays open").toBe(false);
		expect(rb.subst, "never skeletonized").toBeUndefined();
		expect(s.digestOf(rb)).not.toContain("code skeleton");
	});

	it("never skeletonizes a non-code read end-to-end (markdown stays prose)", () => {
		const s = makeStore(codeReadSession("README.md", MD), 4_000, 2_500);
		s.attach(new CodeSkeletonConductor());
		const rb = s.get("r:c1")!;
		// It may be generic-folded to meet budget, but it must NEVER become a code skeleton.
		expect(s.digestOf(rb)).not.toContain("code skeleton");
		expect(s.lastReports).toEqual([]);
	});
});

// ── 4. The repo sample (the demo) ──────────────────────────────────────────────

describe("CodeSkeletonConductor — the bundled sample session", () => {
	const SAMPLE = readFileSync(fileURLToPath(new URL("../../../static/sample-session.jsonl", import.meta.url)), "utf8");

	function sampleStore(): AccordionStore {
		const s = new AccordionStore(parse(SAMPLE));
		s.setProtect(5_000);
		// 70k is above the sample's non-foldable floor (it has several large file WRITES, whose
		// content lives in tool_call blocks that NO conductor can fold) — so the budget is
		// genuinely meetable here, unlike a tighter target.
		s.setBudget(70_000);
		s.attach(new CodeSkeletonConductor());
		return s;
	}

	it("skeletonizes ≥1 real code file, each with a recoverable handle, and reduces context", () => {
		const s = sampleStore();
		const skeletons = s.blocks.filter((b) => s.isFolded(b) && s.digestOf(b).includes("code skeleton"));
		expect(skeletons.length, "at least one large code read is skeletonized").toBeGreaterThanOrEqual(1);
		// Every skeleton carries its recoverable handle.
		for (const b of skeletons) expect(s.digestOf(b).startsWith(`{#${foldCode(b.id)} FOLDED}`)).toBe(true);
		expect(s.liveTokens, "context is reduced").toBeLessThan(s.fullTokens);
		expect(s.liveTokens, "budget is met (floor is below 70k)").toBeLessThanOrEqual(s.budget);
	});

	it("is deterministic — the same session folds to the same set twice", () => {
		const a = sampleStore();
		const b = sampleStore();
		const setOf = (s: AccordionStore) =>
			s.blocks
				.filter((x) => s.isFolded(x))
				.map((x) => x.id)
				.sort();
		expect(setOf(a)).toEqual(setOf(b));
	});
});

// ── 5. Kill switch (ADR 0011 parity) ───────────────────────────────────────────

describe("CodeSkeletonConductor — detach / attach(null)", () => {
	it("detach() freezes the skeletonized view in place (kill switch)", () => {
		const s = makeStore(codeReadSession("arsenal_chaos_client.py", PY), 4_000, 2_500);
		s.attach(new CodeSkeletonConductor());
		const foldedBefore = s.foldedCount;
		expect(foldedBefore).toBeGreaterThan(0);

		s.detach();
		expect(s.foldedCount, "frozen, not cleared").toBe(foldedBefore);
		expect(s.conductor).toBe(null);
	});

	it("attach(null) returns to raw", () => {
		const s = makeStore(codeReadSession("arsenal_chaos_client.py", PY), 4_000, 2_500);
		s.attach(new CodeSkeletonConductor());
		expect(s.foldedCount).toBeGreaterThan(0);

		s.attach(null);
		expect(s.foldedCount).toBe(0);
		expect(s.liveTokens).toBe(s.fullTokens);
	});
});

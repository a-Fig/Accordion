/*
 * doorman.test.ts — conductor-level tests for the birth-fold demonstration conductor, driven
 * through `TestHost` (a real `Truth` instance) exactly as ADR 0018 / the conductor-v2 contract
 * intend. `TestHost.departWire()` fires `wire-departing` (honoring `holdWireUpToMs` — doorman's
 * handler runs synchronously inside that dispatch) and then marks the newest block sent, the
 * same sequence a live `context` hook call would produce.
 */
import { describe, it, expect } from "vitest";
import { DoormanConductor } from "./doorman";
import { TestHost } from "../../conductor/testhost";
import type { Block, ParsedSession } from "../../types";
import type { ConductorHost, HostEvent, ViewBlock } from "../../conductor/contract";
import type { Op } from "../../ops";

// ── block builders ───────────────────────────────────────────────────────────────────────

function userBlock(id: string, turn: number, order: number, text = "hello"): Block {
	return { id, kind: "user", turn, order, text, tokens: Math.ceil(text.length / 4), override: null, autoFolded: false, by: null };
}
function toolCall(id: string, turn: number, order: number, toolName: string, args: Record<string, unknown>): Block {
	const text = `${toolName} ${JSON.stringify(args)}`;
	return { id, kind: "tool_call", turn, order, text, tokens: Math.ceil(text.length / 4), toolName, callId: id, override: null, autoFolded: false, by: null };
}
function toolResult(id: string, turn: number, order: number, callId: string, toolName: string, text: string, opts: { isError?: boolean } = {}): Block {
	return {
		id,
		kind: "tool_result",
		turn,
		order,
		text,
		tokens: Math.ceil(text.length / 4),
		toolName,
		callId,
		isError: opts.isError,
		override: null,
		autoFolded: false,
		by: null,
	};
}

// ── content builders ─────────────────────────────────────────────────────────────────────

/** A real, sizeable Python file: several functions each with a real (elidable) body. */
function bigPythonSource(nFuncs = 15): string {
	const parts: string[] = ["import os", "import sys", "import json", ""];
	for (let i = 0; i < nFuncs; i++) {
		parts.push(`def func_${i}(a, b, c):`);
		parts.push(`    """Compute something useful for func ${i}, with a bit more docs."""`);
		parts.push(`    total = a + b + c`);
		parts.push(`    accumulator = []`);
		for (let j = 0; j < 12; j++) parts.push(`    accumulator.append(a * ${j} + b - ${j})`);
		parts.push(`    for j in range(10):`);
		parts.push(`        total += j * ${i}`);
		parts.push(`        if total > 100:`);
		parts.push(`            total -= 50`);
		parts.push(`    return total + sum(accumulator)`);
		parts.push("");
	}
	return parts.join("\n");
}

/** A large non-code dump — a `grep -R` style hit list. Not a source file; nothing to skeletonize. */
function bigGrepDump(nLines = 200): string {
	const lines: string[] = [];
	for (let i = 0; i < nLines; i++) lines.push(`src/file_${i % 20}.ts:${i}:  const something = doSomething(${i}); // match`);
	return lines.join("\n");
}

/** A big TS file that classifies as code but is ALL signatures — skeletonizing it elides nothing. */
function bigDtsSource(nInterfaces = 80): string {
	const parts: string[] = [];
	for (let i = 0; i < nInterfaces; i++) {
		parts.push(`export interface Thing${i} {`);
		parts.push(`  id: string;`);
		parts.push(`  name: string;`);
		parts.push(`  value: number;`);
		parts.push(`  tags: string[];`);
		parts.push(`}`);
		parts.push("");
	}
	return parts.join("\n");
}

// ── (1) birth-fold: skeletonize ──────────────────────────────────────────────────────────

describe("DoormanConductor — birth-fold skeletonizes a big fresh code read", () => {
	it("Python file read from a prior turn: replaced with header+skeleton while still inside the protected tail", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);

		const py = bigPythonSource(15);
		host.appendBlocks([
			userBlock("u:1", 1, 0, "read util.py for me"),
			toolCall("c:1", 1, 1, "Read", { file_path: "src/util.py" }),
			toolResult("r:1", 1, 2, "c:1", "Read", py),
			userBlock("u:2", 2, 3, "thanks, now do something else"),
		]);

		// The whole tiny transcript fits comfortably inside the default 20k-token protected tail
		// (every block is protected), and r:1 has never been sent — both conditions the birth-fold
		// exemption (Truth.canFold's by:"auto" branch) requires.
		const before = host.get("r:1")!;
		expect(before.protected).toBe(true);
		expect(before.sent).toBe(false);

		host.departWire();

		const after = host.truth.get("r:1")!;
		expect(after.autoFolded).toBe(true);
		expect(after.by).toBe("auto");
		expect(after.override).toBe(null); // a STRATEGY fold, never a human override
		expect(after.subst).toBeDefined();
		expect(after.subst!).toMatch(/^\{#[0-9a-z]{6} FOLDED\} ⟨code skeleton · src\/util\.py · \d+L → \d+L · \d+ elided · call unfold for full source⟩/);
		expect(after.subst!).toContain("def func_0(a, b, c):"); // signature kept
		expect(after.subst!).not.toContain("accumulator.append"); // body elided

		// What the wire (and the agent) actually receives carries the engine's own recovery tag.
		const wireDigest = host.truth.digestOf(after);
		expect(wireDigest).toBe(after.subst);
		expect(wireDigest).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/);

		// Prove birth-fold, not an ordinary fold: the block is STILL protected (the tail walk-back
		// uses full tokens, unaffected by folding — ADR 0018), yet it folded anyway because it was
		// fresh when doorman acted on it.
		expect(host.get("r:1")!.protected).toBe(true);
		expect(host.truth.isFolded(after)).toBe(true);
	});
});

// ── (2) birth-fold: generic engine digest for a non-code giant dump ─────────────────────

describe("DoormanConductor — birth-folds a non-code giant dump to the engine digest", () => {
	it("a big fresh grep dump folds despite being protected+fresh, tagged with the engine's own digest", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);

		const grep = bigGrepDump(200);
		host.appendBlocks([
			userBlock("u:1", 1, 0, "grep for foo"),
			toolCall("c:1", 1, 1, "Bash", { command: "grep -R foo src/" }),
			toolResult("r:1", 1, 2, "c:1", "Bash", grep),
			userBlock("u:2", 2, 3, "ok next"),
		]);

		expect(host.get("r:1")!.protected).toBe(true);
		expect(host.get("r:1")!.sent).toBe(false);

		host.departWire();

		const after = host.truth.get("r:1")!;
		expect(after.autoFolded).toBe(true);
		expect(after.by).toBe("auto");
		expect(after.override).toBe(null);
		expect(after.subst).toBeUndefined(); // NO custom digest — the engine's own per-kind digest
		expect(host.truth.isFolded(after)).toBe(true);

		const wireDigest = host.truth.digestOf(after);
		expect(wireDigest).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/); // still tagged, still recallable
		expect(wireDigest).not.toContain("code skeleton"); // NOT the skeleton path
	});
});

// ── (3) leaves untouched ─────────────────────────────────────────────────────────────────

describe("DoormanConductor — leaves untouched", () => {
	it("a small result (below MIN_SKELETON_TOKENS) stays live", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);
		host.appendBlocks([
			userBlock("u:1", 1, 0),
			toolCall("c:1", 1, 1, "Read", { file_path: "src/tiny.py" }),
			toolResult("r:1", 1, 2, "c:1", "Read", "def f():\n    return 1\n"),
			userBlock("u:2", 2, 3),
		]);
		host.departWire();
		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(false);
	});

	it("an isError result stays live even though it is huge and fresh", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);
		const py = bigPythonSource(15);
		host.appendBlocks([
			userBlock("u:1", 1, 0),
			toolCall("c:1", 1, 1, "Read", { file_path: "src/util.py" }),
			toolResult("r:1", 1, 2, "c:1", "Read", py, { isError: true }),
			userBlock("u:2", 2, 3),
		]);
		host.departWire();
		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(false);
	});

	it("a huge result in the CURRENT (newest) turn stays live — the user may have just asked for it", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);
		const py = bigPythonSource(15);
		host.appendBlocks([userBlock("u:1", 1, 0), toolCall("c:1", 2, 1, "Read", { file_path: "src/util.py" }), toolResult("r:1", 2, 2, "c:1", "Read", py)]);
		host.departWire();
		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(false);
	});

	it("a pinned (held) huge result stays live", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);
		const py = bigPythonSource(15);
		host.appendBlocks([
			userBlock("u:1", 1, 0),
			toolCall("c:1", 1, 1, "Read", { file_path: "src/util.py" }),
			toolResult("r:1", 1, 2, "c:1", "Read", py),
			userBlock("u:2", 2, 3),
		]);
		host.humanPin("r:1");
		host.departWire();
		const after = host.truth.get("r:1")!;
		expect(after.override).toBe("pinned");
		expect(host.truth.isFolded(after)).toBe(false);
	});
});

// ── (4) respects overrides forever — no nagging ──────────────────────────────────────────

describe("DoormanConductor — respects overrides forever", () => {
	it("after the agent unfolds a doorman fold, a later wire-departing does not re-fold it", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);

		const grep = bigGrepDump(200);
		host.appendBlocks([
			userBlock("u:1", 1, 0),
			toolCall("c:1", 1, 1, "Bash", { command: "grep -R foo src/" }),
			toolResult("r:1", 1, 2, "c:1", "Bash", grep),
			userBlock("u:2", 2, 3),
		]);
		host.departWire(); // doorman birth-folds r:1
		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(true);

		host.agentUnfold("r:1"); // the agent calls `unfold` on it
		const afterUnfold = host.truth.get("r:1")!;
		// `override` is the field every future clamp actually gates on (`canFold`'s
		// `if (b.override !== null) return false`), so THIS is the guarantee that matters, and it
		// holds. NOTE (pre-existing Truth behavior, unrelated to doorman): `by` itself comes back
		// `null`, not `"agent"` — `opUnfold` deletes the id from the internal `birthFolded` set
		// (correctly — it is no longer a birth-fold once overridden), but the very same `apply()`
		// call's trailing `housekeep()` → `healProtected()` then sees an `autoFolded` block that is
		// no longer in `birthFolded` and "heals" it as if it were an ordinary aged-out strategy
		// fold, zeroing `by` in the process. `override` (and therefore `isFolded`/future `canFold`)
		// is untouched by that heal, so the override still wins — only the `by` provenance label is
		// collateral. Pinned here as-is (not asserted as "agent") since fixing it is out of scope
		// for this conductor-only change; flagged in the doorman build report for the engine owner.
		expect(afterUnfold.override).toBe("unfolded");
		expect(afterUnfold.by).toBe(null);
		expect(host.truth.isFolded(afterUnfold)).toBe(false);

		const statusCallsBefore = host.statusLog.length;

		// More conversation happens; a later wire-departing must not re-fold r:1 or nag about it.
		host.appendBlocks([toolCall("c:2", 2, 4, "Read", { file_path: "src/other.py" }), toolResult("r:2", 2, 5, "c:2", "Read", "def g():\n    return 2\n"), userBlock("u:3", 3, 6)]);
		host.departWire();

		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(false);
		expect(host.truth.get("r:1")!.override).toBe("unfolded"); // untouched — still the agent's override
		expect(host.statusLog.length).toBe(statusCallsBefore); // no new status mentioning r:1
	});

	/**
	 * A more surgical pin on the `handled`-set bookkeeping itself (independent of Truth's own
	 * override clamp / sent cursor, which the test above already exercises via TestHost): a
	 * hand-rolled `ConductorHost` lets us fire `wire-departing` twice with the SAME id still
	 * reported as fresh, proving doorman's OWN "never revisit an acted-on id" tracking — not
	 * just Truth's independent protection — is what stops the second proposal.
	 */
	it("never re-proposes an id it has already acted on, even if the host still reports it as fresh", () => {
		const grep = bigGrepDump(200);
		const tokens = Math.ceil(grep.length / 4);
		const callBlock: ViewBlock = {
			id: "c:1",
			kind: "tool_call",
			turn: 1,
			order: 1,
			tokens: 10,
			foldedTokens: 10,
			toolName: "Bash",
			callId: "c:1",
			held: false,
			folded: false,
			protected: true,
			grouped: false,
			sent: false,
			text: `Bash {"command":"grep -R foo src/"}`,
		};
		const resultBlock: ViewBlock = {
			id: "r:1",
			kind: "tool_result",
			turn: 1,
			order: 2,
			tokens,
			foldedTokens: 50,
			toolName: "Bash",
			callId: "c:1",
			held: false,
			folded: false,
			protected: true,
			grouped: false,
			sent: false,
			text: grep,
		};
		const userBlk: ViewBlock = { id: "u:2", kind: "user", turn: 2, order: 3, tokens: 5, foldedTokens: 5, held: false, folded: false, protected: true, grouped: false, sent: false, text: "next" };

		const { host, fire, proposals } = makeFakeHost([callBlock, resultBlock, userBlk]);
		const d = new DoormanConductor();
		d.attach(host);

		fire({ type: "wire-departing", rev: 0, liveTokens: 0, budget: 70_000, freshIds: ["r:1"] });
		expect(proposals.length).toBe(1);
		expect(proposals[0].ops).toEqual([{ kind: "fold", ids: ["r:1"] }]);

		// Same id presented as fresh AGAIN — doorman must not propose a second time.
		fire({ type: "wire-departing", rev: 0, liveTokens: 0, budget: 70_000, freshIds: ["r:1"] });
		expect(proposals.length).toBe(1); // unchanged
	});
});

// ── (5) bulk/history sessions ─────────────────────────────────────────────────────────────

describe("DoormanConductor — bulk/history sessions", () => {
	it("never touches a bulk-loaded (non-live) session — every block was born already sent", () => {
		const py = bigPythonSource(15);
		const blocks: Block[] = [userBlock("u:1", 1, 0), toolCall("c:1", 1, 1, "Read", { file_path: "src/util.py" }), toolResult("r:1", 1, 2, "c:1", "Read", py), userBlock("u:2", 2, 3)];
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
		const host = new TestHost(parsed);
		const d = new DoormanConductor();
		d.attach(host);

		expect(host.get("r:1")!.sent).toBe(true); // bulk-loaded: born sent (ADR 0018 §5)

		host.departWire(); // freshIds will be empty — doorman never even scans candidates
		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(false);
	});
});

// ── (6) worth-it rejection ────────────────────────────────────────────────────────────────

describe("DoormanConductor — worth-it rejection", () => {
	it("leaves a classified-as-code file alone when skeletonizing it wouldn't shrink it enough", () => {
		const host = new TestHost();
		const d = new DoormanConductor();
		d.attach(host);
		const dts = bigDtsSource(80); // all top-level interfaces — nothing to elide
		host.appendBlocks([userBlock("u:1", 1, 0), toolCall("c:1", 1, 1, "Read", { file_path: "src/types.ts" }), toolResult("r:1", 1, 2, "c:1", "Read", dts), userBlock("u:2", 2, 3)]);
		host.departWire();
		expect(host.truth.isFolded(host.truth.get("r:1")!)).toBe(false);
	});
});

// ── fake host used only by the surgical "handled" test above ────────────────────────────

function makeFakeHost(blocksList: ViewBlock[]): { host: ConductorHost; fire: (e: HostEvent) => void; proposals: Array<{ baseRev: number; ops: Op[] }> } {
	const byId = new Map(blocksList.map((b) => [b.id, b]));
	const proposals: Array<{ baseRev: number; ops: Op[] }> = [];
	let listener: ((e: HostEvent) => void | Promise<void>) | null = null;
	const host: ConductorHost = {
		on(fn) {
			listener = fn;
			return () => {
				listener = null;
			};
		},
		get(id) {
			return byId.get(id);
		},
		blocks() {
			return blocksList.slice();
		},
		groups() {
			return [];
		},
		textOf(id) {
			return byId.get(id)?.text ?? null;
		},
		stats() {
			return { rev: 0, liveTokens: 0, fullTokens: 0, budget: 70_000, contextWindow: null, protectTokens: 20_000, protectedFromIndex: 0, blockCount: blocksList.length };
		},
		countTokens(text) {
			return Math.ceil(text.length / 4);
		},
		digestOf() {
			return null;
		},
		async complete() {
			throw new Error("not used by this test");
		},
		setStatus() {},
		propose(txn) {
			proposals.push(txn);
			return { rev: 0, results: txn.ops.map((op) => ({ op, applied: true })) };
		},
	};
	return { host, fire: (e) => void listener?.(e), proposals };
}

import { describe, it, expect } from "vitest";
import { parse } from "./parse";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";

// parse() turns raw pi / Claude Code JSONL into typed Blocks. These tests pin the
// current behavior: format sniffing, assistant-message splitting, call/result
// linkage, turn counting, and the empty-block drop rule.

/** Join JSON objects (or pre-rendered strings) into a JSONL document. */
const jsonl = (...lines: (object | string)[]): string =>
	lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");

// ---- pi entry builders ------------------------------------------------------
const piSession = (extra: object = {}) => ({ type: "session", id: "s0", ...extra });
const piUser = (id: string, content: unknown) => ({
	type: "message",
	id,
	message: { role: "user", content },
});
const piAssistant = (id: string, content: unknown[], model = "test-model") => ({
	type: "message",
	id,
	message: { role: "assistant", model, content },
});
const piToolResult = (id: string, o: object) => ({
	type: "message",
	id,
	message: { role: "toolResult", ...o },
});

// ---- Claude entry builders --------------------------------------------------
const ccUser = (uuid: string, content: unknown) => ({
	uuid,
	type: "user",
	message: { role: "user", content },
});
const ccAssistant = (uuid: string, content: unknown[], model = "claude-test") => ({
	uuid,
	type: "assistant",
	message: { role: "assistant", model, content },
});

describe("format detection", () => {
	it("detects pi from a leading session entry and captures cwd/title", () => {
		const s = parse(jsonl(piSession({ cwd: "/proj", title: "My Session" }), piUser("m1", "hello")));
		expect(s.meta.format).toBe("pi");
		expect(s.meta.cwd).toBe("/proj");
		expect(s.meta.title).toBe("My Session");
	});

	it("detects Claude from a uuid + user/assistant entry (not necessarily first line)", () => {
		const s = parse(jsonl({ type: "summary", summary: "irrelevant" }, ccUser("u1", "hi")));
		expect(s.meta.format).toBe("claude");
	});

	it("detects Claude behind an arbitrarily long run of leading non-message lines", () => {
		// Real CC transcripts can open with many uuid-less meta rows (summaries, file-history
		// snapshots) before the first message — detection must scan past them all.
		const leading = Array.from({ length: 30 }, (_, i) => ({ type: "summary", summary: `s${i}` }));
		const s = parse(jsonl(...leading, ccUser("u1", "hi")));
		expect(s.meta.format).toBe("claude");
	});

	it("throws on unrecognized (valid JSON, wrong shape) input", () => {
		expect(() => parse(jsonl({ foo: 1 }, { bar: 2 }))).toThrow(/Unrecognized session format/);
	});

	it("throws on an empty string (no entries → unknown format)", () => {
		expect(() => parse("")).toThrow(/Unrecognized session format/);
	});
});

describe("malformed-line tolerance", () => {
	it("silently skips a broken JSON line; surrounding valid entries still parse", () => {
		const raw = jsonl(piSession(), piUser("m1", "first"), "{this is not json", piUser("m2", "second"));
		const s = parse(raw);
		expect(s.blocks.map((b) => b.text)).toEqual(["first", "second"]);
		// the broken line never became an entry, so it isn't counted in lineCount either
		expect(s.lineCount).toBe(3);
	});
});

describe("pi parsing", () => {
	it("splits one assistant message into thinking / text / tool_call blocks sharing an id prefix", () => {
		const s = parse(
			jsonl(
				piSession(),
				piUser("m1", "go"),
				piAssistant("a1", [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "answer" },
					{ type: "toolCall", id: "call_1", name: "grep", arguments: { q: "x" } },
				]),
			),
		);
		const [user, think, text, call] = s.blocks;
		expect(s.blocks).toHaveLength(4);
		expect([think.kind, text.kind, call.kind]).toEqual(["thinking", "text", "tool_call"]);
		// shared source-message prefix before ":", positional suffix after
		expect([think.id, text.id, call.id]).toEqual(["a1:0", "a1:1", "a1:2"]);
		// global order increments across the whole session
		expect([user.order, think.order, text.order, call.order]).toEqual([0, 1, 2, 3]);
		// tool_call payload: "<name> <json args>" plus linkage fields
		expect(call.text).toBe('grep {"q":"x"}');
		expect(call.toolName).toBe("grep");
		expect(call.callId).toBe("call_1");
		// model is stamped on assistant blocks and hoisted into meta
		expect(think.model).toBe("test-model");
		expect(s.meta.model).toBe("test-model");
	});

	it("links a toolResult back to its call via callId and propagates isError", () => {
		const s = parse(
			jsonl(
				piSession(),
				piUser("m1", "go"),
				piAssistant("a1", [{ type: "toolCall", id: "call_1", name: "grep", arguments: {} }]),
				piToolResult("r1", {
					toolCallId: "call_1",
					toolName: "grep",
					content: [{ type: "text", text: "found it" }],
					isError: true,
				}),
			),
		);
		const result = s.blocks.at(-1)!;
		expect(result.kind).toBe("tool_result");
		expect(result.id).toBe("r1:r");
		expect(result.callId).toBe("call_1");
		expect(result.toolName).toBe("grep");
		expect(result.text).toBe("found it");
		expect(result.isError).toBe(true);
	});

	it("defaults toolResult name to 'tool' and isError to false when absent", () => {
		const s = parse(
			jsonl(piSession(), piUser("m1", "go"), piToolResult("r1", { toolCallId: "c9", content: "ok" })),
		);
		const result = s.blocks.at(-1)!;
		expect(result.toolName).toBe("tool");
		expect(result.isError).toBe(false);
	});

	it("increments the turn on each user message; assistant blocks inherit the current turn", () => {
		const s = parse(
			jsonl(
				piSession(),
				piUser("m1", "first ask"),
				piAssistant("a1", [{ type: "text", text: "reply one" }]),
				piUser("m2", "second ask"),
				piAssistant("a2", [{ type: "text", text: "reply two" }]),
			),
		);
		expect(s.blocks.map((b) => [b.kind, b.turn])).toEqual([
			["user", 1],
			["text", 1],
			["user", 2],
			["text", 2],
		]);
	});

	it("drops empty non-result blocks but KEEPS an empty tool_result", () => {
		const s = parse(
			jsonl(
				piSession(),
				piUser("m1", "go"),
				piAssistant("a1", [{ type: "text", text: "" }]), // dropped
				piToolResult("r1", { toolCallId: "c1", content: "" }), // kept
			),
		);
		expect(s.blocks.map((b) => b.kind)).toEqual(["user", "tool_result"]);
		const empty = s.blocks[1];
		expect(empty.text).toBe("");
		// a dropped block never consumed an order slot
		expect(empty.order).toBe(1);
		expect(empty.tokens).toBe(BLOCK_OVERHEAD); // estTokens("") === 0
	});

	it("records a native compaction entry as a 'compaction' tool_result with a 400-char summary slice", () => {
		const s = parse(jsonl(piSession(), { type: "compaction", id: "c1", summary: "x".repeat(500) }));
		const b = s.blocks[0];
		expect(b.kind).toBe("tool_result");
		expect(b.id).toBe("c1:c");
		expect(b.toolName).toBe("compaction");
		expect(b.turn).toBe(0); // preamble — no user turn yet
		expect(b.text).toBe("⤺ native compaction: " + "x".repeat(400));
		expect(b.callId).toBeUndefined(); // a result-like marker with no paired call
	});

	it("stamps tokens = estTokens(text) + BLOCK_OVERHEAD and counts skipped entry types", () => {
		const text = "some user instruction of a reasonable length";
		const s = parse(jsonl(piSession(), { type: "model_change", id: "x1" }, piUser("m1", text)));
		expect(s.blocks[0].tokens).toBe(estTokens(text) + BLOCK_OVERHEAD);
		expect(s.skipped).toBe(1); // the model_change entry
		expect(s.lineCount).toBe(3);
	});

	it("defaults the title to 'pi session' when the session entry has none", () => {
		const s = parse(jsonl(piSession(), piUser("m1", "hi")));
		expect(s.meta.title).toBe("pi session");
	});
});

describe("Claude Code parsing", () => {
	it("backfills tool_result toolName from the earlier tool_use, falling back to 'tool'", () => {
		const s = parse(
			jsonl(
				ccUser("u1", "run it"),
				ccAssistant("a1", [{ type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } }]),
				ccUser("u2", [
					{ type: "tool_result", tool_use_id: "tu1", content: "out" },
					{ type: "tool_result", tool_use_id: "unknown-id", content: "??", is_error: true },
				]),
			),
		);
		const results = s.blocks.filter((b) => b.kind === "tool_result");
		expect(results).toHaveLength(2);
		expect(results[0].toolName).toBe("Bash"); // backfilled from the tool_use map
		expect(results[0].callId).toBe("tu1");
		expect(results[0].isError).toBe(false);
		expect(results[1].toolName).toBe("tool"); // no map entry → fallback
		expect(results[1].isError).toBe(true);
	});

	it("emits both blocks from a mixed user message (tool_result + text) and increments the turn once", () => {
		const s = parse(
			jsonl(
				ccUser("u1", "start"),
				ccAssistant("a1", [{ type: "tool_use", id: "tu1", name: "Read", input: {} }]),
				ccUser("u2", [
					{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "file body" }] },
					{ type: "text", text: "now do the next thing" },
				]),
			),
		);
		expect(s.blocks.map((b) => b.kind)).toEqual(["user", "tool_call", "tool_result", "user"]);
		const [, , result, user2] = s.blocks;
		expect(result.text).toBe("file body");
		expect(user2.text).toBe("now do the next thing");
		// results are pushed BEFORE the turn bump, so they stay on the previous turn
		expect(result.turn).toBe(1);
		expect(user2.turn).toBe(2);
	});

	it("does NOT increment the turn for a user message that is only tool_results", () => {
		const s = parse(
			jsonl(
				ccUser("u1", "start"),
				ccAssistant("a1", [{ type: "tool_use", id: "tu1", name: "Read", input: {} }]),
				ccUser("u2", [{ type: "tool_result", tool_use_id: "tu1", content: "res" }]),
				ccUser("u3", "real follow-up"),
			),
		);
		const lastUser = s.blocks.at(-1)!;
		expect(lastUser.turn).toBe(2); // tool-result-only message did not consume a turn
	});

	it("splits assistant content (thinking/text/tool_use) with shared uuid prefix, like pi", () => {
		const s = parse(
			jsonl(
				ccUser("u1", "go"),
				ccAssistant("a1", [
					{ type: "thinking", thinking: "let me see" },
					{ type: "text", text: "done" },
				]),
			),
		);
		expect(s.blocks.map((b) => [b.kind, b.id])).toEqual([
			["user", "u1:u"],
			["thinking", "a1:0"],
			["text", "a1:1"],
		]);
		expect(s.meta.model).toBe("claude-test");
	});

	it("picks up title from ai-title entries, cwd from the first entry carrying one, and defaults the title", () => {
		const titled = parse(jsonl({ ...ccUser("u1", "hi"), cwd: "/work" }, { type: "ai-title", aiTitle: "Fix the parser" }));
		expect(titled.meta.title).toBe("Fix the parser");
		expect(titled.meta.cwd).toBe("/work");

		const untitled = parse(jsonl(ccUser("u1", "hi")));
		expect(untitled.meta.title).toBe("Claude Code session");
	});
});

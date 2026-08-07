/*
 * classify.test.ts — a pinning subset of the deleted `app/src/lib/engine/classify.test.ts`
 * (ADR 0016, git rev dc037bc), ported to lock down that the VERBATIM port in `classify.ts`
 * still gates exactly like the original: accepts a real TS/Python code read, rejects a
 * data-extension (JSON) read and a grep dump. Not exhaustive — see the original for the
 * full reject-gate matrix (directory targets, follow streams, piped/chained/multi-file
 * commands, no-extension JSON/YAML, …); this file exists to pin the port, not re-litigate it.
 */
import { describe, it, expect } from "vitest";
import { classifyCodeRead } from "./classify";
import type { ViewBlock } from "../../../core/conductor/contract";

// ───────────────────────── builders (ported from the reference test file) ─────────────────

let nextId = 0;
function freshId(prefix: string): string {
	return `${prefix}${nextId++}`;
}

/** Build a tool_call ViewBlock. `text` is "<name> <JSON args>". */
function call(toolName: string, args: Record<string, unknown>): ViewBlock {
	const id = freshId("call:");
	return {
		id,
		kind: "tool_call",
		turn: 0,
		order: 0,
		tokens: 10,
		foldedTokens: 10,
		toolName,
		callId: id,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		sent: false,
		text: `${toolName} ${JSON.stringify(args)}`,
	};
}

/** Build a tool_result ViewBlock linked to `c` (or standalone if `c` is undefined). */
function result(output: string, opts: { toolName?: string; callId?: string; isError?: boolean; tokens?: number } = {}): ViewBlock {
	const tokens = opts.tokens ?? Math.ceil(output.length / 4);
	return {
		id: freshId("res:"),
		kind: "tool_result",
		turn: 0,
		order: 1,
		tokens,
		foldedTokens: tokens,
		toolName: opts.toolName ?? "tool",
		callId: opts.callId,
		isError: opts.isError,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		sent: false,
		text: output,
	};
}

/** Pair a call + result and return { res, map } ready for classifyCodeRead. */
function pair(c: ViewBlock, output: string, opts: { toolName?: string; isError?: boolean } = {}): { res: ViewBlock; map: Map<string, ViewBlock> } {
	const res = result(output, { toolName: opts.toolName ?? c.toolName, callId: c.callId, isError: opts.isError });
	const map = new Map<string, ViewBlock>([[c.callId!, c]]);
	return { res, map };
}

/** Prefix every non-empty line with a right-aligned `<n>\t` (Claude-Code cat -n style). */
function withLineNumbers(body: string): string {
	const lines = body.split("\n");
	return lines
		.map((line, idx) => {
			const n = String(idx + 1).padStart(5, " ");
			return `${n}\t${line}`;
		})
		.join("\n");
}

const TS_BODY = `import { foo } from "./foo";

export interface Widget {
  id: string;
  size: number;
}

export function build(w: Widget): string {
  const parts: string[] = [];
  for (let i = 0; i < w.size; i++) {
    parts.push(w.id + ":" + i);
  }
  return parts.join(",");
}
`;

const PY_BODY = `import os


class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return "hello " + self.name


def main():
    g = Greeter("world")
    print(g.greet())
`;

// ───────────────────────── ACCEPT cases ─────────────────────────

describe("classifyCodeRead — accepts real code reads", () => {
	it("CC Read of a .ts file with cat -n line-number prefixes → strips prefixes, recovers path", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("/abs/src/widget.ts");
		// The N\t prefix must be gone, but the actual body line survives.
		expect(info!.source).toContain("export function build(w: Widget): string {");
		expect(info!.source).not.toMatch(/^\s*\d+\texport function build/m);
	});

	it("pi read of a .py file → accepts, path from args.path", () => {
		const c = call("read", { path: "src/greeter.py" });
		const { res, map } = pair(c, PY_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/greeter.py");
		expect(info!.source).toContain("class Greeter:");
	});
});

// ───────────────────────── REJECT cases ─────────────────────────

describe("classifyCodeRead — rejects non-code reads", () => {
	it("Read of package.json → null (data extension)", () => {
		const c = call("Read", { file_path: "/repo/package.json" });
		const jsonBody = `{\n  "name": "thing",\n  "version": "1.0.0",\n  "dependencies": { "x": "^1.0.0" }\n}\n`;
		const { res, map } = pair(c, jsonBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Bash `grep -R foo src/` dump → null (search, not a single-file read)", () => {
		const c = call("Bash", { command: "grep -R foo src/" });
		const grepDump = ["src/a.ts:12:  const foo = 1;", "src/b.ts:48:function foo() {}", "src/c.ts:3:// foo here"].join("\n");
		const { res, map } = pair(c, grepDump);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("an errored tool_result → null", () => {
		const c = call("Read", { file_path: "/repo/widget.ts" });
		const { res, map } = pair(c, TS_BODY, { isError: true });
		expect(classifyCodeRead(res, map)).toBeNull();
	});
});

// ───────────────────────── determinism ─────────────────────────

describe("classifyCodeRead — determinism", () => {
	it("classifying the same inputs twice yields equal results", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		expect(classifyCodeRead(res, map)).toEqual(classifyCodeRead(res, map));
	});
});

/*
 * classify.test.ts — unit tests for the code-skeleton conductor's CLASSIFIER.
 *
 * Lives under app/src/lib/ because vitest's include is `src/lib/**\/*.test.ts`. Imports
 * the classifier through the `$conductors` alias (mirrors the in-process import path the
 * conductor itself uses).
 *
 * The classifier is a precision gate: ACCEPT only true large code-file reads; REJECT
 * markdown / json / grep dumps / find listings / ls / git output / base64 images /
 * multi-file & piped shell commands / prose-blobs-in-code-named-files.
 */
import { describe, it, expect } from "vitest";
import { classifyCodeRead } from "$conductors/code-skeleton/classify";
import type { ViewBlock } from "$conductors/contract";

// ───────────────────────── builders ─────────────────────────

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
		text: `${toolName} ${JSON.stringify(args)}`,
	};
}

/** Build a tool_result ViewBlock linked to `c` (or standalone if `c` is undefined). */
function result(
	output: string,
	opts: { toolName?: string; callId?: string; isError?: boolean; tokens?: number } = {},
): ViewBlock {
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
		text: output,
	};
}

/** Pair a call + result and return { result, map } ready for classifyCodeRead. */
function pair(
	c: ViewBlock,
	output: string,
	opts: { toolName?: string; isError?: boolean } = {},
): { res: ViewBlock; map: Map<string, ViewBlock> } {
	const res = result(output, { toolName: opts.toolName ?? c.toolName, callId: c.callId, isError: opts.isError });
	const map = new Map<string, ViewBlock>([[c.callId!, c]]);
	return { res, map };
}

/** A realistic TS source body (no line-number prefixes). */
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

const RS_BODY = `use std::collections::HashMap;

pub struct Cache {
    map: HashMap<String, u64>,
}

impl Cache {
    pub fn new() -> Self {
        Cache { map: HashMap::new() }
    }

    pub fn get(&self, k: &str) -> Option<u64> {
        self.map.get(k).copied()
    }
}
`;

const SVELTE_BODY = `<script lang="ts">
  export let count = 0;
  function inc() {
    count += 1;
  }
</script>

<button on:click={inc}>clicks: {count}</button>
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

	it("pi exec_command `cat foo.rs` with a 6-line header → strips header, path foo.rs", () => {
		const c = call("exec_command", { command: "cat foo.rs" });
		const header = [
			"Command: cat foo.rs",
			"Chunk ID: abc123",
			"Wall time: 12ms",
			"Original token count: 412",
			"Process exited with code 0",
			"Output:",
		].join("\n");
		const { res, map } = pair(c, `${header}\n${RS_BODY}`);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("foo.rs");
		// Header fields must be gone; real code remains.
		expect(info!.source).not.toContain("Command:");
		expect(info!.source).not.toContain("Wall time:");
		expect(info!.source).not.toContain("Output:");
		expect(info!.source).toContain("impl Cache {");
	});

	it("CC Bash `cat src/x.svelte` → accepts as a single-file shell dump", () => {
		const c = call("Bash", { command: "cat src/x.svelte" });
		const { res, map } = pair(c, SVELTE_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/x.svelte");
		expect(info!.source).toContain("function inc()");
	});

	it("shell `sed -n '1,80p' src/widget.ts` → single-file dump, path recovered", () => {
		const c = call("bash", { command: "sed -n '1,80p' src/widget.ts" });
		const { res, map } = pair(c, TS_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/widget.ts");
	});

	it("shell `head -n 50 lib/cache.rs` → single-file dump, path recovered", () => {
		const c = call("bash", { command: "head -n 50 lib/cache.rs" });
		const { res, map } = pair(c, RS_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("lib/cache.rs");
	});

	it("PowerShell `Get-Content src/widget.ts -TotalCount 80` → single-file dump", () => {
		const c = call("powershell", { command: "Get-Content src/widget.ts -TotalCount 80" });
		const { res, map } = pair(c, TS_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/widget.ts");
	});

	it("effective tool name falls back to the call's leading token when result.toolName is 'tool'", () => {
		const c = call("read", { path: "src/greeter.py" });
		// result advertises a generic toolName: "tool" → must fall back to the call.
		const res = result(PY_BODY, { toolName: "tool", callId: c.callId });
		const map = new Map<string, ViewBlock>([[c.callId!, c]]);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/greeter.py");
	});

	it("accepts a .css read by braces alone (no code keywords)", () => {
		const c = call("Read", { file_path: "src/app.css" });
		const cssBody = `:root {\n  --k-user: #6ea8fe;\n  --k-text: #aab2c2;\n}\n\n.cell {\n  width: 10px;\n  height: 10px;\n}\n`;
		const { res, map } = pair(c, cssBody);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("src/app.css");
	});
});

// ───────────────────────── REJECT cases ─────────────────────────

describe("classifyCodeRead — rejects non-code reads", () => {
	it("Read of README.md → null (prose extension)", () => {
		const c = call("Read", { file_path: "/repo/README.md" });
		const mdBody = withLineNumbers(
			`# Title\n\nSome prose paragraph describing the project in plain English.\n\n- bullet one\n- bullet two\n`,
		);
		const { res, map } = pair(c, mdBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Read of package.json → null (data extension)", () => {
		const c = call("Read", { file_path: "/repo/package.json" });
		const jsonBody = `{\n  "name": "thing",\n  "version": "1.0.0",\n  "dependencies": { "x": "^1.0.0" }\n}\n`;
		const { res, map } = pair(c, jsonBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Bash `grep -R foo src/` dump → null (search, not a single-file read)", () => {
		const c = call("Bash", { command: "grep -R foo src/" });
		const grepDump = [
			"src/a.ts:12:  const foo = 1;",
			"src/b.ts:48:function foo() {}",
			"src/c.ts:3:// foo here",
		].join("\n");
		const { res, map } = pair(c, grepDump);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Bash `find app -name '*.ts'` listing → null", () => {
		const c = call("Bash", { command: "find app -name '*.ts'" });
		const findDump = ["app/a.ts", "app/sub/b.ts", "app/sub/c.ts"].join("\n");
		const { res, map } = pair(c, findDump);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Bash `ls -la` → null (directory listing)", () => {
		const c = call("Bash", { command: "ls -la" });
		const lsDump = [
			"total 24",
			"drwxr-xr-x 1 u 0 Jun 21 .",
			"-rw-r--r-- 1 u 12 Jun 21 widget.ts",
		].join("\n");
		const { res, map } = pair(c, lsDump);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Bash `git grep foo` dump → null (git subcommand)", () => {
		const c = call("Bash", { command: "git grep foo -- src/" });
		const dump = ["src/a.ts:1:foo", "src/b.ts:2:foo"].join("\n");
		const { res, map } = pair(c, dump);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Read of a base64 .png → null (binary extension)", () => {
		const c = call("Read", { file_path: "/repo/logo.png" });
		const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".repeat(40);
		const { res, map } = pair(c, b64);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Read of a base64 blob in a code-named .ts → null (fails shape gate)", () => {
		// Extension passes, but content is a flat base64 wall → no code shape.
		const c = call("Read", { file_path: "/repo/blob.ts" });
		const b64 = withLineNumbers(
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mPk".repeat(30),
		);
		const { res, map } = pair(c, b64);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("Read of a .ts file whose content is a wall of prose/log text → null (shape gate)", () => {
		const c = call("Read", { file_path: "/repo/notes.ts" });
		const prose = withLineNumbers(
			[
				"This file used to contain configuration but is now just a written explanation",
				"of why the team decided to remove the previous approach and rely on defaults",
				"instead because maintaining the matrix proved tedious and error prone over time",
				"and several reviewers complained that nobody actually understood the edge cases",
				"so it was removed and this paragraph remains as the historical record for now",
			].join("\n"),
		);
		const { res, map } = pair(c, prose);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("piped command `cat a.ts | grep foo` → null (pipe + grep)", () => {
		const c = call("bash", { command: "cat a.ts | grep foo" });
		const { res, map } = pair(c, "  const foo = 1;\nfunction foo() {}\n");
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("multi-file `cat a.ts b.ts` → null (more than one file)", () => {
		const c = call("bash", { command: "cat a.ts b.ts" });
		const { res, map } = pair(c, TS_BODY + "\n" + TS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("chained command `cat a.ts && echo done` → null (chaining)", () => {
		const c = call("bash", { command: "cat a.ts && echo done" });
		const { res, map } = pair(c, TS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("glob `cat src/*.ts` → null (glob may match many files)", () => {
		const c = call("bash", { command: "cat src/*.ts" });
		const { res, map } = pair(c, TS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("an errored tool_result → null", () => {
		const c = call("Read", { file_path: "/repo/widget.ts" });
		const { res, map } = pair(c, "Error: file not found", { isError: true });
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("a non-tool_result block → null", () => {
		const block: ViewBlock = {
			id: "x:1",
			kind: "text",
			turn: 0,
			order: 0,
			tokens: 100,
			foldedTokens: 100,
			held: false,
			folded: false,
			protected: false,
			grouped: false,
			text: TS_BODY,
		};
		expect(classifyCodeRead(block, new Map())).toBeNull();
	});

	it("an HTML file read → null (html excluded in v1)", () => {
		const c = call("Read", { file_path: "/repo/index.html" });
		const htmlBody = `<!doctype html>\n<html>\n  <body>\n    <div class="x">hi</div>\n  </body>\n</html>\n`;
		const { res, map } = pair(c, htmlBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("an unknown tool family (e.g. WebFetch) → null", () => {
		const c = call("WebFetch", { url: "https://example.com/foo.ts" });
		const { res, map } = pair(c, TS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});
});

// ───────────────────────── path recovery ─────────────────────────

describe("classifyCodeRead — path recovery", () => {
	it("recovers file_path from a CC Read call", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		expect(classifyCodeRead(res, map)!.path).toBe("/abs/src/widget.ts");
	});

	it("recovers path from a pi read call", () => {
		const c = call("read", { path: "lib/cache.rs" });
		const { res, map } = pair(c, RS_BODY);
		expect(classifyCodeRead(res, map)!.path).toBe("lib/cache.rs");
	});

	it("recovers the single file path from a shell-cat command", () => {
		const c = call("bash", { command: "cat ./pkg/main.go" });
		const goBody = `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n`;
		const { res, map } = pair(c, goBody);
		expect(classifyCodeRead(res, map)!.path).toBe("./pkg/main.go");
	});
});

// ───────────────────────── cleaning assertions ─────────────────────────

describe("classifyCodeRead — source cleaning", () => {
	it("line-number stripping: a known body line appears WITHOUT its N\\t prefix", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const numbered = withLineNumbers(TS_BODY);
		// Sanity: the raw output DOES carry the prefix.
		expect(numbered).toMatch(/\d+\timport \{ foo \} from "\.\/foo";/);
		const { res, map } = pair(c, numbered);
		const info = classifyCodeRead(res, map)!;
		// In the cleaned source the same line has NO leading number+tab.
		expect(info.source).toContain('import { foo } from "./foo";');
		expect(info.source).not.toMatch(/\d+\timport \{ foo \}/);
	});

	it("exec_command header stripping: Command:/Wall time: gone, code present", () => {
		const c = call("exec_command", { command: "cat foo.rs" });
		const header = [
			"Command: cat foo.rs",
			"Chunk ID: zzz",
			"Wall time: 4ms",
			"Process exited with code 0",
			"Output:",
		].join("\n");
		const { res, map } = pair(c, `${header}\n${RS_BODY}`);
		const info = classifyCodeRead(res, map)!;
		expect(info.source).not.toContain("Command:");
		expect(info.source).not.toContain("Wall time:");
		expect(info.source).not.toContain("Chunk ID:");
		expect(info.source).not.toContain("Output:");
		expect(info.source.startsWith("use std::collections::HashMap;")).toBe(true);
	});

	it("a real source file that merely contains an early 'Output:' line is NOT header-stripped", () => {
		// No header fields precede it → stripExecHeader must leave the file intact.
		const c = call("read", { path: "src/widget.ts" });
		const body = `export const label = "Output:";\n${TS_BODY}`;
		const { res, map } = pair(c, body);
		const info = classifyCodeRead(res, map)!;
		expect(info.source).toContain('export const label = "Output:";');
	});
});

// ───────────── regression: no-extension reads of JSON/YAML/dir (MAJOR 1) ─────────────

describe("classifyCodeRead — no-extension reads require a code keyword and reject JSON", () => {
	it("read with no path arg + a JSON object body → null (JSON, not code)", () => {
		const c = call("read", {}); // call text is `read {}` — no file_path/path
		const jsonBody = `{\n  "name": "thing",\n  "version": "1.0.0",\n  "items": [1, 2, 3],\n  "nested": { "a": true }\n}\n`;
		const { res, map } = pair(c, jsonBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `cat config` (no ext) + a YAML body → null (no code keyword)", () => {
		const c = call("bash", { command: "cat config" });
		const yamlBody = `server:\n  host: x\n  port: 8080\n  routes:\n    - a\n    - b\n`;
		const { res, map } = pair(c, yamlBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("exec_command `cat config` (no ext) + a flow-style YAML body (punctuation-dense) → null", () => {
		// Flow-style YAML carries {}/[]/:/, so it CLEARS the lenient punctuation+indentation shape
		// gate (this is the actual false positive). It still has no code keyword → must be rejected.
		const c = call("exec_command", { command: "cat config" });
		const yamlBody = [
			"server:",
			"  host: { name: x, ip: 127.0.0.1 }",
			"  port: 8080",
			"  routes: [a, b, c]",
			"  flags: { debug: true, retries: 3 }",
			"  limits: { soft: 10, hard: 20 }",
		].join("\n");
		const { res, map } = pair(c, yamlBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `cat response` (no ext) + a JSON API body → null", () => {
		const c = call("bash", { command: "cat response" });
		const apiBody = `{\n  "status": "ok",\n  "data": { "id": 7, "tags": ["a", "b"] },\n  "count": 2\n}\n`;
		const { res, map } = pair(c, apiBody);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("no-extension read whose body is REAL code (a shell script with a keyword) → STILL accepted", () => {
		const c = call("bash", { command: "cat deploy" }); // no extension
		const scriptBody = [
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"",
			"function foo() {",
			'  echo "building"',
			"  return 0",
			"}",
			"",
			"foo",
		].join("\n");
		const { res, map } = pair(c, scriptBody);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("deploy");
		expect(info!.source).toContain("function foo() {");
	});
});

// ───────────── regression: directory reads rejected (MAJOR 2) ─────────────

describe("classifyCodeRead — directory targets (trailing separator) are rejected", () => {
	it("bash `cat src/` → null (trailing slash is a directory, not a file)", () => {
		const c = call("bash", { command: "cat src/" });
		const body = `export const x = 1;\nfunction y() {\n  return x;\n}\n`;
		const { res, map } = pair(c, body);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `cat ./lib/` → null (trailing slash directory)", () => {
		const c = call("bash", { command: "cat ./lib/" });
		const body = `export const x = 1;\nfunction y() {\n  return x;\n}\n`;
		const { res, map } = pair(c, body);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `cat a.ts` (no trailing slash) → still accepted", () => {
		const c = call("bash", { command: "cat a.ts" });
		const { res, map } = pair(c, TS_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("a.ts");
	});
});

// ───────────── regression: follow streams rejected (MAJOR 3) ─────────────

describe("classifyCodeRead — tail follow streams are rejected", () => {
	it("bash `tail -f a.ts` → null (follow stream, not a snapshot)", () => {
		const c = call("bash", { command: "tail -f a.ts" });
		const { res, map } = pair(c, TS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `tail --follow=name app.ts` → null (follow stream)", () => {
		const c = call("bash", { command: "tail --follow=name app.ts" });
		const { res, map } = pair(c, TS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `tail -F b.rs` → null (follow stream)", () => {
		const c = call("bash", { command: "tail -F b.rs" });
		const { res, map } = pair(c, RS_BODY);
		expect(classifyCodeRead(res, map)).toBeNull();
	});

	it("bash `tail -n 50 a.ts` (NOT follow) → still accepted with path a.ts", () => {
		const c = call("bash", { command: "tail -n 50 a.ts" });
		const { res, map } = pair(c, TS_BODY);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("a.ts");
	});
});

// ───────────── regression: exec-header stripper only on strong markers (MAJOR 4) ─────────────

describe("classifyCodeRead — exec-header stripping only fires on a strong pi marker", () => {
	it("a .ts read whose content opens with Command:/Shell:/Output: (no strong marker) is NOT stripped", () => {
		const c = call("read", { path: "src/widget.ts" });
		const body = "Command: run the thing\nShell: bash\nOutput:\nexport const x = 1;\nfunction y() { return x; }";
		const { res, map } = pair(c, body);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		// No strong pi marker among the pre-`Output:` lines → the whole file (INCLUDING the
		// header-looking opening lines, which here are real source content) must survive intact.
		// The OLD dominance heuristic would delete the prefix through `Output:` → data loss.
		expect(info!.source).toContain("Command: run the thing");
		expect(info!.source).toContain("Shell: bash");
		expect(info!.source).toContain("Output:");
		expect(info!.source).toContain("export const x = 1;");
		expect(info!.source).toContain("function y");
	});

	it("a real pi exec_command result with strong markers → header removed, code intact, classified as .rs", () => {
		const c = call("exec_command", { command: "cat a.rs" });
		const header = [
			"Command: cat a.rs",
			"Chunk ID: 638e65",
			"Wall time: 0.55 seconds",
			"Process exited with code 0",
			"Original token count: 8497",
			"Output:",
		].join("\n");
		const { res, map } = pair(c, `${header}\n${RS_BODY}`);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.path).toBe("a.rs");
		expect(info!.source).not.toContain("Command:");
		expect(info!.source).not.toContain("Wall time:");
		expect(info!.source).not.toContain("Output:");
		expect(info!.source).toContain("impl Cache {");
	});

	it("a pi header with a strong marker AND an interspersed note line → still stripped cleanly (no wrapper leaks)", () => {
		const c = call("exec_command", { command: "cat a.rs" });
		const header = [
			"Command: cat a.rs",
			"Wall time: 0.55 seconds",
			"note: re-ran after a transient failure",
			"Process exited with code 0",
			"Output:",
		].join("\n");
		const { res, map } = pair(c, `${header}\n${RS_BODY}`);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		// Everything through `Output:` is gone, including the interspersed note.
		expect(info!.source).not.toContain("Command:");
		expect(info!.source).not.toContain("Wall time:");
		expect(info!.source).not.toContain("note: re-ran");
		expect(info!.source).not.toContain("Output:");
		expect(info!.source.startsWith("use std::collections::HashMap;")).toBe(true);
	});
});

// ───────────── regression: line-number stripping requires monotonic numbers (MINOR) ─────────────

describe("classifyCodeRead — line-number stripping requires monotonic cat -n numbers", () => {
	it("a CC Read with monotonic `N\\t` prefixes → prefixes stripped", () => {
		// Build a real .ts body, prefix with monotonically increasing numbers, read it back.
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		expect(info!.source).toContain('import { foo } from "./foo";');
		expect(info!.source).not.toMatch(/^\s*\d+\timport \{ foo \}/m);
	});

	it("non-monotonic `N\\t` rows (tabular data, not cat -n) are NOT stripped", () => {
		// Every line is `<number>\t<content>` so the >60% prefix threshold is met, but the
		// leading numbers are NOT ordered → it's arbitrary tabular data column 1, not cat -n
		// line numbers. The monotonic guard must refuse to strip them. The trailing content is
		// real code so the block still classifies (lets us inspect the un-stripped source).
		const c = call("read", { path: "src/table.ts" });
		const body = [
			"100\texport const a = 1;",
			"50\tfunction render() {",
			"200\t  return a;",
			"30\t}",
			"400\tclass Box {",
			"10\t  size = 1;",
			"300\t}",
		].join("\n");
		const { res, map } = pair(c, body);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		// Non-monotonic → the `100\t` / `50\t` / `200\t` prefixes are preserved verbatim.
		expect(info!.source).toContain("100\texport const a = 1;");
		expect(info!.source).toContain("50\tfunction render() {");
		expect(info!.source).toContain("200\t  return a;");
	});

	it("monotonic `N\\t` rows over the same content ARE stripped (control for the guard)", () => {
		// Same content as above but with monotonically increasing prefixes → genuine cat -n.
		const c = call("read", { path: "src/table.ts" });
		const body = [
			"1\texport const a = 1;",
			"2\tfunction render() {",
			"3\t  return a;",
			"4\t}",
			"5\tclass Box {",
			"6\t  size = 1;",
			"7\t}",
		].join("\n");
		const { res, map } = pair(c, body);
		const info = classifyCodeRead(res, map);
		expect(info).not.toBeNull();
		// Monotonic → prefixes stripped; the bare code lines remain.
		expect(info!.source).toContain("export const a = 1;");
		expect(info!.source).not.toMatch(/^\s*\d+\texport const a/m);
	});
});

// ───────────────────────── determinism ─────────────────────────

describe("classifyCodeRead — determinism", () => {
	it("classifying the same inputs twice yields equal results", () => {
		const c = call("Read", { file_path: "/abs/src/widget.ts" });
		const { res, map } = pair(c, withLineNumbers(TS_BODY));
		const a = classifyCodeRead(res, map);
		const b = classifyCodeRead(res, map);
		expect(a).toEqual(b);
		expect(a).not.toBeNull();
	});

	it("a rejected input is deterministically null", () => {
		const c = call("Read", { file_path: "/repo/README.md" });
		const { res, map } = pair(c, "# Title\n\nprose prose prose\n");
		expect(classifyCodeRead(res, map)).toBeNull();
		expect(classifyCodeRead(res, map)).toBeNull();
	});
});

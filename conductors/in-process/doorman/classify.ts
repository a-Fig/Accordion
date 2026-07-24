/*
 * conductors/in-process/doorman/classify.ts
 *
 * Ported VERBATIM (every reject gate byte-identical, only this banner comment and the
 * `ViewBlock` import path rewritten) from the deleted `conductors/code-skeleton/classify.ts`
 * (ADR 0016, git rev dc037bc) for the "doorman" conductor — the reject-biased code-read
 * classifier that decides whether a giant fresh `tool_result` is a code-file read worth
 * skeletonizing (`doorman.ts`) or should instead fall through to a plain birth-fold.
 *
 * Given a `tool_result` block (an agent's view of a tool's output) plus the map of
 * tool-call blocks, decide whether the block is a LARGE CODE-FILE READ worth
 * skeletonizing, and if so recover the file path + the cleaned source code (tool
 * wrappers and line-number prefixes stripped). It REJECTS non-code big blocks
 * (markdown, grep/find dumps, base64 images, JSON API responses, directory listings).
 *
 * WHY this is precision-critical: a naive "fold the biggest blocks" conductor would
 * skeletonize the wrong things — a 40 KB grep dump, a base64 PNG, or a README are all
 * large but are NOT a source file with structure to skeletonize. Replacing them with a
 * "code skeleton" would be destructive and nonsensical. So the gates below are biased
 * toward REJECTION: a block must clear every gate to be accepted.
 *
 * Gate order (each gate can only reject; the last produces the result):
 *   1. kind/error gate     — must be a non-error `tool_result`.
 *   2. tool-family gate     — must be a direct file read (read/cat/view/…) OR a
 *                             single-file shell dump (`cat`/`head`/`sed -n`/`Get-Content`
 *                             with exactly one file, no pipe / search / listing / chain).
 *                             Anything else (grep, find, ls, git, multi-file, piped) → null.
 *   3. path + extension gate — the recovered path's extension must be in the CODE set and
 *                             NOT in the PROSE/DATA set. (No path ⇒ fall through to shape.)
 *   4. CLEAN the source     — strip Claude-Code `cat -n` line-number prefixes and the pi
 *                             `exec_command` header. Done BEFORE the shape gate so the gate
 *                             sees real code, not wrappers.
 *   5. content-shape gate   — the cleaned source must actually look like code (>=2 of:
 *                             a code keyword, healthy structural-punctuation density,
 *                             multiple indented lines). Guards a blob hiding in a
 *                             code-named file. css is special-cased (selectors, not keywords).
 *
 * Pure & deterministic: no Date / Math.random / global state. No `$lib`, no app imports.
 */

import type { ViewBlock } from "../../../core/conductor/contract";

export interface CodeReadInfo {
	/** Recovered file path (or undefined if only inferable from content). */
	path: string | undefined;
	/** Cleaned source: tool wrappers + line-number prefixes stripped, ready to skeletonize. */
	source: string;
}

/** Effective-name sets for the tool-family gate. */
const READ_TOOLS = new Set(["read", "view", "cat", "readfile", "read_file", "open"]);
const SHELL_TOOLS = new Set([
	"bash",
	"shell",
	"sh",
	"exec_command",
	"run_command",
	"execute",
	"powershell",
	"pwsh",
]);

/** Extensions we DO skeletonize (real source with structure). */
const CODE_EXTS = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"svelte",
	"vue",
	"py",
	"pyi",
	"rs",
	"go",
	"java",
	"kt",
	"kts",
	"c",
	"h",
	"cpp",
	"cc",
	"hpp",
	"cxx",
	"rb",
	"php",
	"swift",
	"sql",
	"css",
	"scss",
	"less",
	"sh",
	"bash",
]);

/** Extensions we explicitly REJECT (prose / data / binary). */
const PROSE_DATA_EXTS = new Set([
	"md",
	"markdown",
	"txt",
	"rst",
	"json",
	"yaml",
	"yml",
	"toml",
	"lock",
	"csv",
	"log",
	"html",
	"xml",
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"pdf",
]);

/** Extensions for which the keyword/punctuation shape gate is replaced by a braces check. */
const CSS_EXTS = new Set(["css", "scss", "less"]);

const CODE_KEYWORDS = [
	"function ",
	"class ",
	"def ",
	"import ",
	"export ",
	"const ",
	"fn ",
	"struct ",
	"impl ",
	"interface ",
	"public ",
	"async ",
	"return ",
	"package ",
	"#include",
];

/**
 * Is `block` (expected kind "tool_result") a large code-file READ worth skeletonizing?
 * `callById` maps callId -> the originating tool_call ViewBlock, so we can recover the
 * path/command. Returns the cleaned source + path, or null if it's not a code file read.
 *
 * Does NOT apply a token-size threshold — the conductor decides that. But DOES apply the
 * content-shape and extension gates here.
 */
export function classifyCodeRead(block: ViewBlock, callById: Map<string, ViewBlock>): CodeReadInfo | null {
	// Gate 1: must be a non-error tool_result with content.
	if (block.kind !== "tool_result" || block.isError) return null;
	const rawOutput = block.text;
	if (typeof rawOutput !== "string" || rawOutput.length === 0) return null;

	// Recover the originating call (if any) and its parsed args.
	const call = block.callId ? callById.get(block.callId) : undefined;
	const callText = call?.text;
	const args = parseCallArgs(callText);

	// Gate 2 (part A): determine the effective tool name.
	const effName = effectiveToolName(block.toolName, callText);
	if (!effName) return null;

	// Gate 2 (part B): branch by tool family to recover a candidate path.
	let path: string | undefined;
	if (READ_TOOLS.has(effName)) {
		// Direct file read: path comes straight from the args.
		path = asPath(args.file_path) ?? asPath(args.path);
	} else if (SHELL_TOOLS.has(effName)) {
		// Shell-cat read: the command must be a single-file dump (no pipe/search/listing/chain).
		const command = asString(args.command);
		if (command === undefined) return null;
		path = singleFileCatTarget(command);
		if (path === undefined) return null; // not a clean single-file dump → reject
	} else {
		return null; // unknown tool family
	}

	// Gate 3: extension gate. A known path must have a code extension and not a prose/data one.
	if (path !== undefined) {
		const ext = extensionOf(path);
		if (ext !== undefined) {
			if (PROSE_DATA_EXTS.has(ext)) return null;
			if (!CODE_EXTS.has(ext)) return null;
		} else {
			// Path with no usable extension: be conservative, fall through to the shape gate.
		}
	}
	// If path is undefined we may still proceed, but the shape gate must be convincing.

	// Gate 4: clean the source BEFORE shaping so the gate sees real code.
	const source = cleanSource(rawOutput);
	if (source.length === 0) return null;

	// Gate 5: content-shape gate.
	const ext = path !== undefined ? extensionOf(path) : undefined;
	const cssMode = ext !== undefined && CSS_EXTS.has(ext);
	const knownCodeExt = ext !== undefined && CODE_EXTS.has(ext);
	if (!looksLikeCode(source, cssMode)) return null;
	// When the extension does NOT vouch for the file (path undefined, or a basename with no
	// usable / non-code extension) and it isn't css, the lenient shape gate is not enough:
	// JSON / YAML / dir-listings pass it on punctuation+indentation alone. So additionally
	// REQUIRE a real code keyword and REJECT anything that parses as JSON. Known-code-extension
	// reads (.ts/.py/…) keep the lenient gate — the extension is the vouch. css keeps its
	// braces-only gate (cssMode short-circuits above).
	if (!knownCodeExt && !cssMode) {
		if (!hasCodeKeyword(source)) return null;
		if (looksLikeJson(source)) return null;
	}

	return { path, source };
}

// ───────────────────────────── helpers ─────────────────────────────

/** Lowercased leading token of a tool_call's text (the tool name), or undefined. */
function leadingToolName(callText: string | undefined): string | undefined {
	if (typeof callText !== "string") return undefined;
	const trimmed = callText.trimStart();
	if (trimmed.length === 0) return undefined;
	// The name is everything up to the first whitespace or the first `{`.
	const m = trimmed.match(/^([^\s{]+)/);
	if (!m) return undefined;
	return m[1].toLowerCase();
}

/**
 * Effective tool name: lowercase of `block.toolName`; if missing or the generic "tool",
 * fall back to the leading token of the originating call's text.
 */
function effectiveToolName(toolName: string | undefined, callText: string | undefined): string | undefined {
	const own = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
	if (own !== "" && own !== "tool") return own;
	return leadingToolName(callText);
}

/**
 * Parse a tool_call's args: take the JSON object from the first `{` to the end and
 * JSON.parse it. Defensive — any failure yields `{}`.
 */
function parseCallArgs(callText: string | undefined): Record<string, unknown> {
	if (typeof callText !== "string") return {};
	const start = callText.indexOf("{");
	if (start < 0) return {};
	const jsonPart = callText.slice(start);
	try {
		const parsed = JSON.parse(jsonPart);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	return {};
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** Non-empty trimmed string, else undefined. */
function asPath(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t.length > 0 ? t : undefined;
}

/** Lowercased file extension (no dot) of a path, or undefined if there isn't a real one. */
function extensionOf(path: string): string | undefined {
	// Strip any trailing quotes/whitespace and take the basename.
	const cleaned = path.trim().replace(/^["']|["']$/g, "");
	const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
	const dot = base.lastIndexOf(".");
	// No dot, leading-dot dotfile (".gitignore"), or trailing dot ⇒ no usable extension.
	if (dot <= 0 || dot === base.length - 1) return undefined;
	return base.slice(dot + 1).toLowerCase();
}

/**
 * If `command` is a single-file dump (`cat`/`head`/`tail`/`sed -n`/`type`/`Get-Content`/`gc`
 * naming exactly ONE file, no pipe / search / listing / chain / glob), return that file path.
 * Otherwise undefined. Allows an optional leading `type`/`cat`/`bat` paginator wrapper.
 */
function singleFileCatTarget(command: string): string | undefined {
	const cmd = command.trim();
	if (cmd.length === 0) return undefined;

	// Hard rejects on dangerous structure anywhere in the command.
	if (/[|]/.test(cmd)) return undefined; // any pipe
	if (/&&|\|\||;/.test(cmd)) return undefined; // command chaining
	if (/[<>]/.test(cmd)) return undefined; // redirection
	if (/`|\$\(/.test(cmd)) return undefined; // command substitution

	// Reject FOLLOW streams (`tail -f`, `-F`, `--follow`, PowerShell `-Wait`) regardless of
	// position: a follow stream is an unbounded tail of appended lines, not a file snapshot,
	// and usually lacks the top of the file — never a skeletonizable read.
	if (/(^|\s)(-f|-F|--follow(=\S*)?|-Wait)(\s|$)/.test(cmd)) return undefined;

	// Reject search / listing / VCS subcommands regardless of position (word-boundary).
	if (/\b(grep|rg|egrep|fgrep|ag|ack|find|fd|ls|dir|get-childitem|gci|tree)\b/i.test(cmd)) return undefined;
	if (/\bgit\s+\w/i.test(cmd)) return undefined; // a git subcommand

	// Tokenize honoring quotes.
	const tokens = tokenizeCommand(cmd);
	if (tokens.length === 0) return undefined;

	// Strip an optional leading paginator wrapper: `type FILE`, `cat FILE`, `bat FILE`.
	// (We only peel ONE such wrapper; the real dump verb is checked next.)
	let i = 0;
	const first = tokens[0].toLowerCase();
	if ((first === "type" || first === "cat" || first === "bat") && tokens.length > 2) {
		// Peel only if what FOLLOWS is itself one of our dump verbs (e.g. `type cat`); a bare
		// `cat FILE` is handled directly below, so don't peel in the common single-verb case.
		const second = tokens[1].toLowerCase();
		if (DUMP_VERBS.has(second) || (second === "get-content" || second === "gc")) {
			i = 1;
		}
	}

	const verb = tokens[i].toLowerCase();
	let rest = tokens.slice(i + 1);

	// `sed -n '1,80p' FILE` — verb is sed, require the -n flag, then a range arg, then file.
	if (verb === "sed") {
		if (!rest.some((t) => t === "-n")) return undefined;
		// Drop sed flags and the line-range/script argument(s); keep non-flag, non-range tokens.
		const fileCandidates = rest.filter((t) => !t.startsWith("-") && !isSedScript(t));
		return soleFile(fileCandidates);
	}

	if (verb === "get-content" || verb === "gc") {
		// PowerShell: Get-Content [-Path] FILE [-TotalCount N] … — keep non-flag tokens that
		// aren't the numeric value of a count flag.
		return soleFile(stripFlagsAndValues(rest));
	}

	if (DUMP_VERBS.has(verb)) {
		// cat / head / tail / type — `head -n 80 FILE`, `tail -5 FILE`, `cat FILE`.
		return soleFile(stripFlagsAndValues(rest));
	}

	return undefined; // leading verb isn't a recognized single-file dump
}

const DUMP_VERBS = new Set(["cat", "head", "tail", "type"]);

/** A sed script/range argument like `1,80p`, `'1,80p'`, `5p`, `$p`. */
function isSedScript(t: string): boolean {
	const s = t.replace(/^["']|["']$/g, "");
	return /^[$\d][\d,]*[a-z]?$/i.test(s) || /p$/.test(s);
}

/**
 * From candidate tokens, return the sole file path or undefined if there are zero or
 * more than one (multi-file dumps are rejected). Also rejects glob `*` matches and any
 * target that ends in a path separator (`src/`, `lib\`) — a directory is never a single file.
 */
function soleFile(candidates: string[]): string | undefined {
	const files = candidates.map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => t.length > 0);
	if (files.length !== 1) return undefined; // zero or multi-file → reject
	const file = files[0];
	if (file.includes("*") || file.includes("?")) return undefined; // glob → could be multi-match
	if (/[\\/]$/.test(file)) return undefined; // trailing separator → a directory, not a file
	return file;
}

/** Drop `-flag` tokens and a numeric value immediately following a flag (e.g. `-n 80`). */
function stripFlagsAndValues(tokens: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("-")) {
			// `-n80` style carries its own value; `-n 80` consumes the next numeric token.
			const next = tokens[i + 1];
			if (next !== undefined && /^\d+$/.test(next.replace(/^["']|["']$/g, ""))) i++;
			continue;
		}
		out.push(t);
	}
	return out;
}

/** Split a shell command into tokens, honoring single/double quotes (quotes kept on token). */
function tokenizeCommand(cmd: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur.length > 0) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur.length > 0) tokens.push(cur);
	return tokens;
}

/**
 * Clean a tool-result's raw output into source:
 *  - strip a pi `exec_command` header (Command:/Wall time:/…/Output:) if clearly present,
 *  - strip Claude-Code `cat -n` line-number prefixes (`<spaces><number>\t`) if a strong
 *    majority of non-empty lines have them,
 *  - trim a trailing `(truncated)` note.
 */
function cleanSource(raw: string): string {
	let text = stripExecHeader(raw);
	text = stripLineNumberPrefixes(text);
	text = stripTrailingTruncation(text);
	return text;
}

/**
 * If the output starts with a pi `exec_command` header block — lines like `Command: …`,
 * `Chunk ID: …`, `Wall time: …`, `Process exited with code N`, `Original token count: …` —
 * terminated by a line that is exactly `Output:`, drop everything through that `Output:` line.
 *
 * Only strips when a STRONG pi-specific marker (`Wall time:`, `Chunk ID:`, `Original token
 * count:`, `Process exited with code`) is present among the pre-`Output:` lines. Real pi
 * `exec_command` output always carries one of these; a genuine source file that merely opens
 * with `Command:` / `Shell:` and an early `Output:` line does NOT — so it is left untouched
 * (otherwise we'd silently delete the top of a real file). When a strong marker is present we
 * strip through `Output:` even if an interspersed non-header note line exists, so no wrapper
 * fragment leaks into the source.
 */
function stripExecHeader(raw: string): string {
	const lines = raw.split("\n");
	// Find the `Output:` terminator within a small window at the top.
	const limit = Math.min(lines.length, 12);
	let outputIdx = -1;
	for (let i = 0; i < limit; i++) {
		if (lines[i].trim() === "Output:") {
			outputIdx = i;
			break;
		}
	}
	if (outputIdx < 0) return raw;
	// Require a STRONG pi-specific marker among the preceding lines. These appear in real pi
	// exec_command output but not at the top of an ordinary source file, so they (not generic
	// `Command:`/`Shell:` lines) are what authorizes deleting the prefix.
	const strongRe = /^(Wall time:|Chunk ID:|Original token count:|Process exited with code\b)/i;
	let strong = 0;
	for (let i = 0; i < outputIdx; i++) {
		if (strongRe.test(lines[i].trim())) strong++;
	}
	if (strong === 0) return raw;
	return lines.slice(outputIdx + 1).join("\n");
}

/**
 * Claude-Code Read results are `cat -n` style: every line is `<spaces><number>\t<content>`.
 * If >60% of non-empty lines match `^\s*\d+\t`, strip that prefix from matching lines
 * (leaving non-matching lines untouched).
 *
 * The matched numbers must also be MONOTONICALLY NON-DECREASING (the cat -n shape). This
 * distinguishes line numbers from genuine columnar/tabular data (e.g. `100\tfoo`,
 * `50\tbar`), which happens to start each row with a number+tab but is not ordered.
 */
function stripLineNumberPrefixes(text: string): string {
	const lines = text.split("\n");
	const prefixRe = /^\s*(\d+)\t/;
	let nonEmpty = 0;
	let matching = 0;
	let prev = -Infinity;
	let monotonic = true;
	for (const line of lines) {
		if (line.trim() === "") continue;
		nonEmpty++;
		const m = prefixRe.exec(line);
		if (m) {
			matching++;
			const n = Number(m[1]);
			if (n < prev) monotonic = false;
			prev = n;
		}
	}
	if (nonEmpty === 0) return text;
	if (matching / nonEmpty <= 0.6) return text;
	if (!monotonic) return text; // arbitrary tabular data, not cat -n line numbers
	return lines.map((line) => (prefixRe.test(line) ? line.replace(prefixRe, "") : line)).join("\n");
}

/** Trim a single trailing truncation note like `… (truncated)` / `[truncated]`, conservatively. */
function stripTrailingTruncation(text: string): string {
	// Anchored to the very end ($); only strips a bare trailing note, not the word mid-file.
	return text.replace(/[\s.…]*[([]?\s*truncated\s*[)\]]?\s*$/i, "");
}

/**
 * Content-shape gate. On the cleaned source, require >=2 signals within the first ~4 KB:
 *  (a) a code keyword present,
 *  (b) healthy structural-punctuation density,
 *  (c) multiple lines that look like indented code.
 * For css/scss/less just require `{` and `}` present (selectors, not keywords).
 */
function looksLikeCode(source: string, cssMode: boolean): boolean {
	const head = source.slice(0, 4096);

	if (cssMode) {
		return head.includes("{") && head.includes("}");
	}

	let signals = 0;

	// (a) code keyword
	if (hasCodeKeyword(head)) signals++;

	// (b) structural-punctuation density: count of {}()[];: relative to length.
	const punct = (head.match(/[{}()\[\];:]/g) ?? []).length;
	// ~1 structural char per 40 chars is a healthy floor for real code; also need a small
	// absolute count so a tiny snippet of prose with one colon doesn't pass.
	if (punct >= 6 && punct / head.length >= 0.012) signals++;

	// (c) multiple indented lines (leading 2+ spaces or a tab, with actual content).
	const lines = head.split("\n");
	let indented = 0;
	for (const line of lines) {
		if (/^(\t| {2,})\S/.test(line)) indented++;
	}
	if (indented >= 2) signals++;

	return signals >= 2;
}

/** True if a code keyword from CODE_KEYWORDS appears in `text` (checked over the first ~4 KB). */
function hasCodeKeyword(text: string): boolean {
	const head = text.slice(0, 4096);
	return CODE_KEYWORDS.some((kw) => head.includes(kw));
}

/**
 * True if the cleaned source IS a JSON document — `JSON.parse` of the trimmed text succeeds
 * AND yields an object or array (a bare string/number/bool/null is not a "JSON file" worth
 * rejecting on; real code never round-trips through JSON.parse as an object/array anyway).
 * Used to reject a JSON body read with no code extension before it sneaks through the shape
 * gate on structural punctuation alone.
 */
function looksLikeJson(source: string): boolean {
	const trimmed = source.trim();
	if (trimmed.length === 0) return false;
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return false; // cheap pre-check; objects/arrays only
	try {
		const parsed = JSON.parse(trimmed);
		return parsed !== null && typeof parsed === "object";
	} catch {
		return false;
	}
}

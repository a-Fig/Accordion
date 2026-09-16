/*
 * triptych/skeleton.mjs — production code skeletonizer for the "triptych" conductor.
 *
 * Ported from the skeleton-lab research candidate "tree-sitter" (branch
 * claude/code-skeleton-extraction-rv0ovo), pinned at that research's L2 level:
 * imports/exports/type aliases/interfaces/enums are kept whole, function and
 * method bodies are elided to a short marker, ALL comments and (Python)
 * docstrings are dropped, and any literal (object/array/dict/list/set/tuple,
 * or a large embedded string) spanning more than 6 source lines is elided.
 *
 * Strategy (unchanged from the lab candidate): parse a candidate source span with
 * web-tree-sitter, walk the tree once, and SPLICE the original source — copy
 * kept byte ranges verbatim, replace elided ranges with a short marker. Same
 * input -> same edit list -> byte-identical output; untouched code keeps its
 * original formatting exactly.
 *
 * Two deliberate upgrades over the lab candidate, per the ast-exact research
 * candidate's output spec:
 *
 *  1. Elision markers are ASCII (never a bare U+2026 "…") and carry a line
 *     count: a brace-language body elides to `{ /* ... N lines *\/ }`, a
 *     Python body elides to `...  # ... N lines` (a valid one-line `...`
 *     statement followed by a trailing comment, sitting at the indentation
 *     the source already has before the body's start index — see
 *     `handlePyBody` below). An elided long literal/segment gets the
 *     analogous `/* ... N lines *\/` treatment, placed so the file stays
 *     syntactically plausible (a Python collection literal can't use a `#`
 *     comment on the same line as trailing code, so it gets its own line
 *     between the literal's open/close brackets instead — see
 *     `literalMarker`).
 *  2. The module's default export is the exact init/ready/skeletonize
 *     injection contract the conductor imports (see bottom of file) rather
 *     than the lab harness's `{ id, label, languages, levels, init,
 *     skeletonize({source,lang,level}) }` candidate shape.
 *
 * Total + deterministic, same as the lab candidate: `skeletonize` NEVER
 * throws. Any internal error (including one caused by malformed/adversarial
 * input) returns null rather than propagating — the one exception is that a
 * tree-sitter ERROR node itself is NOT treated as a hard failure: it is
 * recursed into (if it recovered named children) or given a head/tail
 * excerpt (if it didn't), exactly like the lab candidate, so a truncated or
 * malformed-but-mostly-valid source span still produces a real skeleton instead of
 * null.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Grammar loading
// ---------------------------------------------------------------------------

const WASM_FILES = {
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  js: "tree-sitter-javascript.wasm",
  py: "tree-sitter-python.wasm",
};

function wasmDir() {
  // Resolve via node module resolution (robust to hoisting depth / cwd)
  // rather than a hardcoded relative path from this file.
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkgJson), "out");
}

let parserInitPromise = null;
let initPromise = null;
let readyFlag = false;
// lang key -> ready-to-use Parser instance. Populated synchronously (inside
// the async init chain) so `skeletonize` itself can stay fully synchronous,
// as the injection contract requires.
const parsers = new Map();

async function ensureParserRuntime() {
  if (!parserInitPromise) parserInitPromise = Parser.init();
  await parserInitPromise;
}

/** Async wasm init: Parser.init() + Language.load() for ts/tsx/js/py,
 * resolved via createRequire(import.meta.url). Idempotent. */
function init() {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureParserRuntime();
      const dir = wasmDir();
      for (const [key, file] of Object.entries(WASM_FILES)) {
        const language = await Language.load(path.join(dir, file));
        const parser = new Parser();
        parser.setLanguage(language);
        parsers.set(key, parser);
      }
      readyFlag = true;
    })();
  }
  return initPromise;
}

function ready() {
  return readyFlag;
}

// ---------------------------------------------------------------------------
// In-context language hints
// ---------------------------------------------------------------------------

const HINTS = new Map([
  ["ts", "typescript"], ["typescript", "typescript"], ["tsx", "typescript"],
  ["js", "javascript"], ["javascript", "javascript"], ["jsx", "javascript"],
  ["py", "python"], ["python", "python"],
]);

function normalizedHint(hint) {
  if (hint === undefined || hint === null || String(hint).trim() === "") return null;
  return HINTS.get(String(hint).trim().toLowerCase()) ?? "unsupported";
}

function candidateSpecs(source, hint) {
  const h = normalizedHint(hint);
  if (h === "unsupported") return [];
  if (h === "python") return [{ parser: "py", language: "python" }];
  if (h === "typescript") return [
    { parser: "ts", language: "typescript" },
    { parser: "tsx", language: "typescript" },
  ];
  if (h === "javascript") return [
    { parser: "js", language: "javascript" },
    { parser: "tsx", language: "javascript" },
  ];

  // With no in-context hint, try all three supported languages. Ordering only breaks exact
  // score ties: TypeScript-specific syntax prefers TS; ordinary brace code prefers JavaScript.
  const typeScriptShaped = /\b(?:interface|namespace|enum|implements|abstract|declare)\b|\btype\s+[A-Za-z_$][\w$]*\s*=|\bas\s+const\b/.test(source);
  const brace = typeScriptShaped
    ? [{ parser: "ts", language: "typescript" }, { parser: "tsx", language: "typescript" }, { parser: "js", language: "javascript" }]
    : [{ parser: "js", language: "javascript" }, { parser: "ts", language: "typescript" }, { parser: "tsx", language: "javascript" }];
  return [{ parser: "py", language: "python" }, ...brace];
}

// Ts/tsx/js all share the same node-type vocabulary; python is its own.
function defsKey(lang) {
  return lang === "py" ? "py" : "ts";
}

// ---------------------------------------------------------------------------
// Language node-type tables
// ---------------------------------------------------------------------------

const TS_DEFS = {
  commentType: "comment",
  importTypes: new Set(["import_statement"]),
  functionTypes: new Set([
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "generator_function",
    "method_definition",
    "arrow_function",
  ]),
  blockType: "statement_block",
};

const PY_DEFS = {
  commentType: "comment",
  importTypes: new Set(["import_statement", "import_from_statement", "future_import_statement"]),
  functionTypes: new Set(["function_definition"]),
  blockType: "block",
};

function defsFor(lang) {
  return defsKey(lang) === "py" ? PY_DEFS : TS_DEFS;
}

const TS_LITERAL_TYPES = new Set(["object", "array"]);
const PY_LITERAL_TYPES = new Set(["dictionary", "list", "set", "tuple"]);

function literalTypesFor(lang) {
  return defsKey(lang) === "py" ? PY_LITERAL_TYPES : TS_LITERAL_TYPES;
}
function valueFieldFor(lang) {
  return defsKey(lang) === "py" ? "right" : "value";
}
function isBlockType(t, lang) {
  return t === defsFor(lang).blockType;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isCommentNode(node, lang) {
  return node.type === defsFor(lang).commentType;
}

function isDocstringStatement(node, lang) {
  if (defsKey(lang) !== "py") return false;
  if (node.type !== "expression_statement") return false;
  if (node.namedChildCount !== 1) return false;
  const child = node.namedChild(0);
  if (!child || child.type !== "string") return false;
  const parent = node.parent;
  if (!parent) return false;
  const first = parent.namedChild(0);
  return !!first && first.id === node.id;
}

const STRING_LITERAL_TYPES = new Set(["string", "template_string"]);

function spansMoreThanLines(node, n) {
  return node.endPosition.row - node.startPosition.row + 1 > n;
}

/** "N line"/"N lines" — markers read naturally at N=1 (review nit). */
function linesLabel(n) {
  return `${n} line${n === 1 ? "" : "s"}`;
}

/** Number of lines a text fragment spans (1 for a single line, 0 for ""). */
function countLines(text) {
  if (text === "") return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Bounded search for a big multi-line string literal buried inside a value
 * expression (e.g. `re.compile(r'''...multi-line...''')`) — not just a
 * direct object/array/dict/list literal. Depth-limited: this is meant to
 * catch "obviously large constant data", not to become a general expression
 * walker. */
function findLargeStringDescendant(node, depth) {
  if (STRING_LITERAL_TYPES.has(node.type) && spansMoreThanLines(node, 6)) return node;
  if (depth <= 0) return null;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const hit = findLargeStringDescendant(c, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function findLargeLiteralValue(node, lang) {
  const value = node.childForFieldName(valueFieldFor(lang));
  if (!value) return null;
  if (literalTypesFor(lang).has(value.type) && spansMoreThanLines(value, 6)) return value;
  return findLargeStringDescendant(value, 4);
}

/** ASCII, line-counted elision marker for a large literal/string value.
 * Never contains U+2026. For a string/template literal, the marker sits
 * BETWEEN the original open/close quote delimiters so the result stays a
 * valid (if now-marker-only) string of the same kind. For a non-string
 * collection literal (object/array/dict/list/set/tuple) in a brace language,
 * it's a same-line `{ /* ... N lines *\/ }`-shaped stub. Python has no block
 * comment, so a Python collection literal's marker is a `#` comment on its
 * OWN line between the literal's open/close brackets — never on the same
 * line as the closing bracket, so it can never swallow trailing same-line
 * code that follows the literal (e.g. `{...}.items()`). */
function literalMarker(value, lang) {
  const t = value.text;
  const n = countLines(t);
  if (STRING_LITERAL_TYPES.has(value.type)) {
    const m = /^[a-zA-Z]*("""|'''|["'`])/.exec(t);
    const open = m ? m[0] : t.slice(0, 1);
    const quote = m ? m[1] : t.slice(0, 1);
    return `${open}/* ... ${linesLabel(n)} */${quote}`;
  }
  const first = t.length ? t[0] : "";
  const last = t.length > 1 ? t[t.length - 1] : first;
  if (defsKey(lang) === "py") {
    return `${first}\n    # ... ${linesLabel(n)}\n${last}`;
  }
  if (t.length < 2) return `{ /* ... ${linesLabel(n)} */ }`;
  return `${first} /* ... ${linesLabel(n)} */ ${last}`;
}

function removeEdit(node) {
  return { start: node.startIndex, end: node.endIndex, text: "" };
}

function handleErrorNodeEdit(node, edits) {
  const text = node.text;
  if (text.length <= 800) return; // small enough to just leave verbatim
  const head = text.slice(0, 300);
  const tail = text.slice(-300);
  edits.push({
    start: node.startIndex,
    end: node.endIndex,
    text: `${head}\n/* ... ERROR region elided (${text.length} chars) ... */\n${tail}`,
  });
}

// ---------------------------------------------------------------------------
// L2 — generic recursive splice: bodies elided, comments/docstrings dropped
// ---------------------------------------------------------------------------

function handleFunctionLike(node, ctx) {
  const body = node.childForFieldName("body");
  if (!body || !isBlockType(body.type, ctx.lang)) return; // concise/expr body, ambient sig: leave as-is
  if (defsKey(ctx.lang) === "py") {
    handlePyBody(body, ctx);
  } else {
    const n = countLines(body.text);
    ctx.edits.push({ start: body.startIndex, end: body.endIndex, text: `{ /* ... ${linesLabel(n)} */ }` });
  }
}

/** Elide an entire Python function/method suite to one `...  # ... N lines`
 * line — a valid one-statement body (the `...` Ellipsis literal used as a
 * statement) followed by a trailing comment. The replaced range starts at
 * the suite's own startIndex, so the indentation already present in the
 * source immediately before it (never touched by this edit) is what the
 * marker inherits — no indent needs to be computed or reattached. */
function handlePyBody(body, ctx) {
  const n = countLines(body.text);
  ctx.edits.push({ start: body.startIndex, end: body.endIndex, text: `...  # ... ${linesLabel(n)}` });
}

function visitL2(node, ctx) {
  if (node.type === "ERROR") {
    // tree-sitter's recovery sometimes types a node ERROR while still giving
    // it a rich set of named children (e.g. a file truncated near the end:
    // the WHOLE root can come back as ERROR even though most of it is
    // perfectly good sub-structure). Recurse into whatever it recovered
    // instead of discarding it — only a childless ERROR is a true opaque
    // blob that needs the head/tail excerpt treatment.
    const kids = node.namedChildren.filter(Boolean);
    if (kids.length > 0) {
      for (const c of kids) visitL2(c, ctx);
      return;
    }
    handleErrorNodeEdit(node, ctx.edits);
    return;
  }
  if (isCommentNode(node, ctx.lang)) {
    ctx.edits.push(removeEdit(node));
    return;
  }
  if (isDocstringStatement(node, ctx.lang)) {
    ctx.edits.push(removeEdit(node));
    return;
  }
  if (ctx.defs.importTypes.has(node.type)) return; // kept whole
  if (ctx.defs.functionTypes.has(node.type)) {
    handleFunctionLike(node, ctx);
    return;
  }
  {
    const lit = findLargeLiteralValue(node, ctx.lang);
    if (lit) {
      ctx.edits.push({ start: lit.startIndex, end: lit.endIndex, text: literalMarker(lit, ctx.lang) });
      return;
    }
  }
  for (const c of node.namedChildren) {
    if (c) visitL2(c, ctx);
  }
  // Everything not specially handled above — import/export wrappers, type
  // aliases, interfaces, enums, class/module containers themselves — falls
  // through this generic recursion untouched (kept whole) unless something
  // nested inside it (a method body, a large literal, a comment) triggers
  // one of the specific edits above.
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  for (const e of sorted) {
    if (e.start < cursor) continue; // defensive: never let an overlap corrupt output
    out += source.slice(cursor, e.start);
    out += e.text;
    cursor = Math.max(cursor, e.end);
  }
  out += source.slice(cursor);
  return out;
}

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Content confidence
// ---------------------------------------------------------------------------

const TS_STRONG = new Set([
  "import_statement", "export_statement", "function_declaration", "generator_function_declaration",
  "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration",
  "namespace_declaration", "ambient_declaration",
]);
const TS_WEAK = new Set([
  "lexical_declaration", "variable_declaration", "method_definition", "arrow_function",
  "for_statement", "for_in_statement", "while_statement", "if_statement", "switch_statement",
]);
const PY_STRONG = new Set([
  "import_statement", "import_from_statement", "future_import_statement", "function_definition",
  "class_definition", "decorated_definition",
]);
const PY_WEAK = new Set([
  "assignment", "typed_parameter", "for_statement", "while_statement", "if_statement",
  "with_statement", "try_statement", "match_statement",
]);

function isMissing(node) {
  return typeof node.isMissing === "function" ? node.isMissing() : node.isMissing === true;
}

/** Reject prose/data that a permissive grammar can technically recover into a tree. */
function confidenceOf(root, lang, source, hinted) {
  const strongTypes = defsKey(lang) === "py" ? PY_STRONG : TS_STRONG;
  const weakTypes = defsKey(lang) === "py" ? PY_WEAK : TS_WEAK;
  let strong = 0;
  let weak = 0;
  let missing = 0;
  let errorBytes = 0;
  const visit = (node) => {
    if (node.type === "ERROR") {
      const recovered = node.namedChildren.filter(Boolean);
      if (recovered.length > 0) {
        // A truncated file can surface a root ERROR while retaining a rich, trustworthy subtree.
        // Judge that recovered structure instead of charging the whole source as invalid.
        for (const child of recovered) visit(child);
      } else {
        errorBytes += Math.max(1, node.endIndex - node.startIndex);
      }
      return;
    }
    if (isMissing(node)) missing++;
    if (strongTypes.has(node.type)) strong++;
    else if (weakTypes.has(node.type)) weak++;
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  const errorRatio = errorBytes / Math.max(1, source.length);
  const anchorCount = strong + weak;
  const maxErrorRatio = hinted ? 0.4 : 0.2;
  if (anchorCount === 0 || strong === 0 && weak < 2 || errorRatio > maxErrorRatio) return null;
  return strong * 100 + weak * 12 - errorRatio * 1000 - missing * 25;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Content-only L2 skeletonization for TypeScript/JavaScript/Python. NEVER throws. */
function skeletonize(source, hint) {
  try {
    if (!readyFlag) return null;
    const src = typeof source === "string" ? source : String(source ?? "");
    if (src.trim().length === 0) return null;
    const hinted = normalizedHint(hint) !== null;
    let best = null;
    for (const spec of candidateSpecs(src, hint)) {
      const parser = parsers.get(spec.parser);
      if (!parser) continue;
      let tree = null;
      try {
        tree = parser.parse(src);
        if (!tree) continue;
        const score = confidenceOf(tree.rootNode, spec.parser, src, hinted);
        if (score === null) continue;
        const edits = [];
        visitL2(tree.rootNode, { lang: spec.parser, defs: defsFor(spec.parser), source: src, edits });
        const skeleton = collapseBlankLines(applyEdits(src, edits));
        // A permissive grammar can recover structure from logs or data. If L2 cannot make the
        // candidate smaller, it is not code Triptych can usefully skeletonize.
        if (edits.length === 0 || skeleton.length >= src.length) continue;
        const result = {
          language: spec.language,
          skeleton,
          score,
        };
        if (best === null || result.score > best.score) best = result;
      } finally {
        // Tree-sitter trees live in wasm memory the JS GC never sees.
        try {
          tree?.delete();
        } catch {
          /* a tree that failed mid-parse may already be freed */
        }
      }
    }
    return best === null ? null : { language: best.language, skeleton: best.skeleton };
  } catch {
    return null;
  }
}

export default {
  init,
  ready,
  skeletonize,
};

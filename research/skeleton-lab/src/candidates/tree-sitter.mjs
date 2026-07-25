/*
 * research/skeleton-lab — "tree-sitter" candidate.
 *
 * One uniform, grammar-driven extraction strategy across ts/tsx/js/py, using
 * web-tree-sitter (wasm) + the prebuilt grammars from tree-sitter-wasms.
 *
 * Strategy: parse the file, walk the tree once, and SPLICE the original
 * source — copy kept byte ranges verbatim, replace elided ranges with a
 * short marker. This keeps determinism trivial (same input -> same edit
 * list -> same output) and formatting natural (untouched code keeps its
 * original whitespace/comments/blank lines).
 *
 * Levels:
 *  - L1 "interface view": function/method bodies elided (Python keeps a
 *    leading docstring), comments and docstrings otherwise untouched, large
 *    literals elided.
 *  - L2 "signatures only": L1 minus every comment node and every Python
 *    docstring statement.
 *  - L3 "API card": statement-level classification. Non-exported / private
 *    top-level and class-member declarations are dropped and counted;
 *    exported/public ones are collapsed to a single normalized-whitespace
 *    line; imports collapse to one summary line.
 *
 * Total + deterministic: every public entry point is wrapped so a parse
 * failure, an unsupported shape, or an internal bug degrades to a plain
 * head/tail excerpt instead of throwing.
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

let parserInitPromise = null;
const languageCache = new Map(); // lang -> Promise<Language>
const parserCache = new Map(); // lang -> Promise<Parser>

function wasmDir() {
  // Resolve via node module resolution (robust to hoisting depth / cwd)
  // rather than a hardcoded relative path from this file.
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkgJson), "out");
}

async function ensureParserRuntime() {
  if (!parserInitPromise) parserInitPromise = Parser.init();
  await parserInitPromise;
}

async function getLanguage(langKey) {
  if (!languageCache.has(langKey)) {
    languageCache.set(
      langKey,
      (async () => {
        await ensureParserRuntime();
        const file = path.join(wasmDir(), WASM_FILES[langKey]);
        return Language.load(file);
      })(),
    );
  }
  return languageCache.get(langKey);
}

async function getParser(langKey) {
  if (!parserCache.has(langKey)) {
    parserCache.set(
      langKey,
      (async () => {
        const language = await getLanguage(langKey);
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      })(),
    );
  }
  return parserCache.get(langKey);
}

async function init() {
  await ensureParserRuntime();
  await Promise.all(Object.keys(WASM_FILES).map((k) => getParser(k)));
}

// tsx shares its grammar shape with ts; "ts" is the canonical key for both.
function langKey(lang) {
  return lang === "tsx" ? "tsx" : lang === "py" ? "py" : lang === "js" ? "js" : "ts";
}
function defsKey(lang) {
  return lang === "py" ? "py" : "ts"; // ts/tsx/js all share the same node-type vocabulary
}

// ---------------------------------------------------------------------------
// Language node-type tables
// ---------------------------------------------------------------------------

const TS_DEFS = {
  programType: "program",
  commentType: "comment",
  importTypes: new Set(["import_statement"]),
  exportStatementType: "export_statement",
  functionTypes: new Set([
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "generator_function",
    "method_definition",
    "arrow_function",
  ]),
  classTypes: new Set(["class_declaration", "class"]),
  typeTypes: new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]),
  variableStmtTypes: new Set(["lexical_declaration", "variable_declaration"]),
  blockType: "statement_block",
};

const PY_DEFS = {
  programType: "module",
  commentType: "comment",
  importTypes: new Set(["import_statement", "import_from_statement", "future_import_statement"]),
  exportStatementType: null,
  functionTypes: new Set(["function_definition"]),
  classTypes: new Set(["class_definition"]),
  typeTypes: new Set(),
  variableStmtTypes: new Set(),
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

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function indentOf(node, source) {
  const lineStart = source.lastIndexOf("\n", node.startIndex - 1) + 1;
  return source.slice(lineStart, node.startIndex);
}

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

function findLargeLiteralValue(node, lang) {
  const value = node.childForFieldName(valueFieldFor(lang));
  if (!value) return null;
  if (!literalTypesFor(lang).has(value.type)) return null;
  const lineCount = value.endPosition.row - value.startPosition.row + 1;
  if (lineCount <= 6) return null;
  return value;
}

function findLargeLiteralShallow(node, lang) {
  const direct = findLargeLiteralValue(node, lang);
  if (direct) return direct;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const hit = findLargeLiteralValue(c, lang);
    if (hit) return hit;
  }
  return null;
}

function literalMarker(value) {
  const t = value.text;
  if (t.length < 2) return "{ … }";
  return `${t[0]} … ${t[t.length - 1]}`;
}

function removeEdit(node) {
  return { start: node.startIndex, end: node.endIndex, text: "" };
}

// L1 keeps comments/docstrings, but an "interface view" means the summary,
// not necessarily every paragraph of a long design-rationale essay — a
// comment/docstring past this many lines is truncated to its opening lines
// plus an ellipsis continuation (still a real, syntactically-closed
// comment/string, never a dangling delimiter).
const DOC_LINE_THRESHOLD = 8;
const DOC_HEAD_LINES = 4;

function truncateBlockCommentText(text) {
  if (!text.startsWith("/*")) return null; // a `//` line comment is always 1 line already
  const lines = text.split("\n");
  if (lines.length <= DOC_LINE_THRESHOLD) return null;
  const head = lines.slice(0, DOC_HEAD_LINES).join("\n");
  return `${head}\n * …\n */`;
}

function truncateDocstringText(text) {
  const quote = text.slice(0, 3);
  if (quote !== '"""' && quote !== "'''") return null; // single/double-quoted "docstring": already 1 line
  const lines = text.split("\n");
  if (lines.length <= DOC_LINE_THRESHOLD) return null;
  const head = lines.slice(0, DOC_HEAD_LINES).join("\n");
  return `${head}\n…\n${quote}`;
}

function maybeTruncateDocstringNode(strNode, edits) {
  const truncated = truncateDocstringText(strNode.text);
  if (truncated) edits.push({ start: strNode.startIndex, end: strNode.endIndex, text: truncated });
}

function handleErrorNodeEdit(node, edits) {
  const text = node.text;
  if (text.length <= 800) return; // small enough to just leave verbatim
  const head = text.slice(0, 300);
  const tail = text.slice(-300);
  edits.push({
    start: node.startIndex,
    end: node.endIndex,
    text: `${head}\n/* … ERROR region elided (${text.length} chars) … */\n${tail}`,
  });
}

// ---------------------------------------------------------------------------
// L1 / L2 — generic recursive splice (bodies elided, nothing dropped)
// ---------------------------------------------------------------------------

function handleFunctionLikeL12(node, ctx) {
  const body = node.childForFieldName("body");
  if (!body || !isBlockType(body.type, ctx.lang)) return; // concise/expr body, ambient sig: leave as-is
  if (defsKey(ctx.lang) === "py") {
    handlePyBodyL12(node, body, ctx);
  } else {
    ctx.edits.push({ start: body.startIndex, end: body.endIndex, text: "{ … }" });
  }
}

function handlePyBodyL12(node, body, ctx) {
  const first = body.namedChild(0);
  const hasDocstring = !!(
    first &&
    first.type === "expression_statement" &&
    first.namedChildCount === 1 &&
    first.namedChild(0) &&
    first.namedChild(0).type === "string"
  );
  if (ctx.level === 1 && hasDocstring) {
    maybeTruncateDocstringNode(first.namedChild(0), ctx.edits);
    if (body.namedChildCount === 1) return; // body is just the docstring
    const indent = indentOf(body, ctx.source);
    ctx.edits.push({ start: first.endIndex, end: body.endIndex, text: `\n${indent}...` });
    return;
  }
  ctx.edits.push({ start: body.startIndex, end: body.endIndex, text: "..." });
}

function visitL12(node, ctx) {
  if (node.type === "ERROR") {
    handleErrorNodeEdit(node, ctx.edits);
    return;
  }
  if (isCommentNode(node, ctx.lang)) {
    if (ctx.level >= 2) {
      ctx.edits.push(removeEdit(node));
    } else {
      const truncated = truncateBlockCommentText(node.text);
      if (truncated) ctx.edits.push({ start: node.startIndex, end: node.endIndex, text: truncated });
    }
    return;
  }
  if (isDocstringStatement(node, ctx.lang)) {
    if (ctx.level >= 2) {
      ctx.edits.push(removeEdit(node));
    } else {
      maybeTruncateDocstringNode(node.namedChild(0), ctx.edits);
    }
    return;
  }
  if (ctx.defs.importTypes.has(node.type)) return; // kept whole
  if (ctx.defs.functionTypes.has(node.type)) {
    handleFunctionLikeL12(node, ctx);
    return;
  }
  {
    const lit = findLargeLiteralValue(node, ctx.lang);
    if (lit) {
      ctx.edits.push({ start: lit.startIndex, end: lit.endIndex, text: literalMarker(lit) });
      return;
    }
  }
  for (const c of node.namedChildren) {
    if (c) visitL12(c, ctx);
  }
}

// ---------------------------------------------------------------------------
// L3 — statement-level public/private classification, one line per symbol
// ---------------------------------------------------------------------------

function extractModuleName(node, lang) {
  if (defsKey(lang) === "py") {
    const moduleField = node.childForFieldName("module_name");
    if (moduleField) return moduleField.text;
    const dotted = node.namedChild(0);
    return dotted ? dotted.text : null;
  }
  const source = node.childForFieldName("source");
  if (!source) return null;
  return source.text.replace(/^["'`]|["'`]$/g, "");
}

function collapseImportsL3(root, defs, lang, edits) {
  const top = root.namedChildren.filter(Boolean);
  const importNodes = top.filter((n) => defs.importTypes.has(n.type));
  const ids = new Set(importNodes.map((n) => n.id));
  if (importNodes.length === 0) return ids;
  const names = importNodes.map((n) => extractModuleName(n, lang)).filter(Boolean);
  const mark = defsKey(lang) === "py" ? "#" : "//";
  const summary = `${mark} imports: ${names.join(", ")}`;
  edits.push({ start: importNodes[0].startIndex, end: importNodes[0].endIndex, text: summary });
  for (let i = 1; i < importNodes.length; i++) {
    edits.push(removeEdit(importNodes[i]));
  }
  return ids;
}

function oneLineFunctionSig(node, lang, source, rangeStart) {
  const body = node.childForFieldName("body");
  const hasBlock = body && isBlockType(body.type, lang);
  const stub = defsKey(lang) === "py" ? "..." : "{ … }";
  const start = rangeStart ?? node.startIndex;
  if (!hasBlock) return normalizeWhitespace(source.slice(start, node.endIndex));
  const sig = normalizeWhitespace(source.slice(start, body.startIndex));
  return `${sig} ${stub}`;
}

function oneLineFallback(node, lang, source) {
  const lit = findLargeLiteralShallow(node, lang);
  if (!lit) return normalizeWhitespace(node.text);
  const before = normalizeWhitespace(source.slice(node.startIndex, lit.startIndex));
  const after = normalizeWhitespace(source.slice(lit.endIndex, node.endIndex));
  return `${before} ${literalMarker(lit)}${after ? after : ""}`;
}

function isMemberPublic(node) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === "accessibility_modifier" && (c.text === "private" || c.text === "protected")) {
      return false;
    }
  }
  const nameNode = node.childForFieldName("name") || node.childForFieldName("property");
  const nm = nameNode ? nameNode.text : "";
  if (nm.startsWith("#") || nm.startsWith("_")) return false;
  return true;
}

function isModuleExportsAssignment(stmt) {
  if (stmt.type !== "expression_statement") return false;
  const expr = stmt.namedChild(0);
  if (!expr || expr.type !== "assignment_expression") return false;
  const left = expr.childForFieldName("left");
  if (!left) return false;
  const text = left.text;
  return text === "module.exports" || text.startsWith("module.exports.") || text.startsWith("exports.");
}

function classifyDeclarationL3(decl, defs, lang, source, exportedOverride, isModule) {
  const publicFlag = exportedOverride === null ? isMemberPublic(decl) : exportedOverride;
  if (defs.functionTypes.has(decl.type)) {
    if (!publicFlag) return { kind: "drop" };
    return { kind: "oneline", text: oneLineFunctionSig(decl, lang, source) };
  }
  if (defs.classTypes.has(decl.type)) {
    if (!publicFlag) return { kind: "drop" };
    const body = decl.childForFieldName("body");
    if (!body) return { kind: "oneline", text: normalizeWhitespace(decl.text) };
    const header = normalizeWhitespace(source.slice(decl.startIndex, body.startIndex));
    return { kind: "class", classBody: body, headerText: header };
  }
  if (defs.typeTypes.has(decl.type)) {
    if (!publicFlag) return { kind: "drop" };
    return { kind: "oneline", text: normalizeWhitespace(decl.text) };
  }
  if (defs.variableStmtTypes.has(decl.type)) {
    if (!publicFlag) return { kind: "drop" };
    return { kind: "oneline", text: oneLineFallback(decl, lang, source) };
  }
  // class fields / property signatures / anything else declaration-shaped
  if (!publicFlag) return { kind: "drop" };
  return { kind: "oneline", text: normalizeWhitespace(decl.text) };
  void isModule;
}

function classifyTsJsL3(stmt, defs, lang, source, isModule) {
  if (defs.exportStatementType && stmt.type === defs.exportStatementType) {
    const decl = stmt.childForFieldName("declaration");
    if (!decl) return { kind: "oneline", text: normalizeWhitespace(stmt.text) };
    return classifyDeclarationL3(decl, defs, lang, source, true, isModule);
  }
  if (isModuleExportsAssignment(stmt)) {
    return { kind: "oneline", text: oneLineFallback(stmt, lang, source) };
  }
  if (isModule) {
    if (
      defs.functionTypes.has(stmt.type) ||
      defs.classTypes.has(stmt.type) ||
      defs.typeTypes.has(stmt.type) ||
      defs.variableStmtTypes.has(stmt.type)
    ) {
      return { kind: "drop" }; // non-exported top-level declaration
    }
    return { kind: "oneline", text: normalizeWhitespace(stmt.text) }; // stray top-level statement
  }
  return classifyDeclarationL3(stmt, defs, lang, source, null, isModule); // class member
}

function classifyPyL3(stmt, defs, lang, source, isModule) {
  if (stmt.type === "decorated_definition") {
    const def = stmt.childForFieldName("definition");
    if (def && (defs.functionTypes.has(def.type) || defs.classTypes.has(def.type))) {
      const nameNode = def.childForFieldName("name");
      const name = nameNode ? nameNode.text : null;
      if (name && name.startsWith("_")) return { kind: "drop" };
      if (defs.functionTypes.has(def.type)) {
        return { kind: "oneline", text: oneLineFunctionSig(def, lang, source, stmt.startIndex) };
      }
      const body = def.childForFieldName("body");
      if (!body) return { kind: "oneline", text: normalizeWhitespace(stmt.text) };
      const header = normalizeWhitespace(source.slice(stmt.startIndex, body.startIndex));
      return { kind: "class", classBody: body, headerText: header };
    }
    return { kind: "oneline", text: normalizeWhitespace(stmt.text) };
  }

  let name = null;
  if (defs.functionTypes.has(stmt.type) || defs.classTypes.has(stmt.type)) {
    const nameNode = stmt.childForFieldName("name");
    name = nameNode ? nameNode.text : null;
  } else if (stmt.type === "expression_statement") {
    const inner = stmt.namedChild(0);
    if (inner && inner.type === "assignment") {
      const left = inner.childForFieldName("left");
      name = left && left.type === "identifier" ? left.text : null;
    }
  }
  const isPrivateByName = !!(name && name.startsWith("_"));

  if (defs.functionTypes.has(stmt.type)) {
    if (isPrivateByName) return { kind: "drop" };
    return { kind: "oneline", text: oneLineFunctionSig(stmt, lang, source) };
  }
  if (defs.classTypes.has(stmt.type)) {
    if (isPrivateByName) return { kind: "drop" };
    const body = stmt.childForFieldName("body");
    if (!body) return { kind: "oneline", text: normalizeWhitespace(stmt.text) };
    const header = normalizeWhitespace(source.slice(stmt.startIndex, body.startIndex));
    return { kind: "class", classBody: body, headerText: header };
  }
  if (name !== null) {
    if (isPrivateByName) return { kind: "drop" };
    return { kind: "oneline", text: oneLineFallback(stmt, lang, source) };
  }
  // unrecognized shape (if/for/with/try/bare-expr at module scope, etc.) — keep, neutral
  return { kind: "oneline", text: normalizeWhitespace(stmt.text) };
  void isModule;
}

function classifyStatementL3(stmt, defs, lang, source, isModule) {
  return defsKey(lang) === "py"
    ? classifyPyL3(stmt, defs, lang, source, isModule)
    : classifyTsJsL3(stmt, defs, lang, source, isModule);
}

function processContainerL3(container, defs, lang, source, edits, importIds, isModule) {
  let privateCount = 0;
  const kids = container.namedChildren.filter(Boolean);
  for (const stmt of kids) {
    if (stmt.type === "ERROR") {
      handleErrorNodeEdit(stmt, edits);
      continue;
    }
    if (isCommentNode(stmt, lang)) {
      edits.push(removeEdit(stmt));
      continue;
    }
    if (isDocstringStatement(stmt, lang)) {
      edits.push(removeEdit(stmt));
      continue;
    }
    if (importIds.has(stmt.id)) continue; // already handled by the imports pre-pass
    if (defs.importTypes.has(stmt.type)) continue; // stray nested import — leave in place

    let result;
    try {
      result = classifyStatementL3(stmt, defs, lang, source, isModule);
    } catch {
      result = { kind: "oneline", text: normalizeWhitespace(stmt.text) };
    }

    if (result.kind === "drop") {
      edits.push(removeEdit(stmt));
      privateCount++;
    } else if (result.kind === "oneline") {
      edits.push({ start: stmt.startIndex, end: stmt.endIndex, text: result.text });
    } else if (result.kind === "class") {
      edits.push({ start: stmt.startIndex, end: result.classBody.startIndex, text: `${result.headerText} ` });
      processContainerL3(result.classBody, defs, lang, source, edits, new Set(), false);
    }
  }
  if (privateCount > 0) {
    const mark = defsKey(lang) === "py" ? "#" : "//";
    if (isModule) {
      edits.push({
        start: container.endIndex,
        end: container.endIndex,
        text: `\n${mark} … ${privateCount} private member${privateCount === 1 ? "" : "s"} not shown\n`,
      });
    } else {
      const pos = Math.max(container.startIndex, container.endIndex - 1);
      edits.push({
        start: pos,
        end: pos,
        text: `  ${mark} … ${privateCount} private member${privateCount === 1 ? "" : "s"} not shown\n`,
      });
    }
  }
}

function runL3(root, defs, lang, source, edits) {
  const importIds = collapseImportsL3(root, defs, lang, edits);
  processContainerL3(root, defs, lang, source, edits, importIds, true);
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

function headTailExcerpt(source) {
  const HEAD = 1000;
  const TAIL = 500;
  if (source.length <= HEAD + TAIL) return source;
  return `${source.slice(0, HEAD)}\n/* … truncated … */\n${source.slice(-TAIL)}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function skeletonizeInner(source, lang, level) {
  const src = typeof source === "string" ? source : String(source ?? "");
  if (!WASM_FILES[langKey(lang)]) {
    throw new Error(`unsupported lang: ${lang}`);
  }
  const parser = await getParser(langKey(lang));
  const tree = parser.parse(src);
  if (!tree) throw new Error("parse returned null");
  const root = tree.rootNode;
  const defs = defsFor(lang);
  const edits = [];

  if (level === 3) {
    runL3(root, defs, lang, src, edits);
  } else {
    visitL12(root, { lang, level, defs, source: src, edits });
  }

  const spliced = applyEdits(src, edits);
  return { skeleton: collapseBlankLines(spliced) };
}

async function skeletonize(input) {
  const { source, lang, level } = input ?? {};
  try {
    return await skeletonizeInner(source, lang, level);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const raw = typeof source === "string" ? source : String(source ?? "");
    return { skeleton: `/* tree-sitter failed: ${reason} */\n${headTailExcerpt(raw)}` };
  }
}

export default {
  id: "tree-sitter",
  label: "Tree-sitter (wasm)",
  languages: ["ts", "tsx", "js", "py"],
  levels: [1, 2, 3],
  init,
  skeletonize,
};

/*
 * ast-exact — full-fidelity AST-based skeleton extraction.
 *
 * ts/tsx/js: uses the TypeScript compiler API (`ts.createSourceFile`, error
 * tolerant) to slice signatures directly out of the ORIGINAL source text via
 * node.getStart()/getEnd() offsets, so formatting is never reconstructed —
 * only elided.
 *
 * py: shells out to `py_skeleton.py` (stdin/stdout JSON), which does the
 * analogous thing against Python's `ast` module.
 *
 * See src/contract.mjs for the interface and level semantics this module
 * must satisfy.
 */

import ts from "typescript";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_HELPER = path.join(__dirname, "ast-exact", "py_skeleton.py");

const SMALL_INIT_MAX = 40;

// ---------------------------------------------------------------------------
// shared utilities
// ---------------------------------------------------------------------------

function countLines(text) {
  if (text === "") return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function collapse(text) {
  return text.replace(/\s+/g, " ").trim();
}

function excerpt(source, headChars = 500, tailChars = 500) {
  if (source.length <= headChars + tailChars) return source;
  return source.slice(0, headChars) + "\n/* … */\n" + source.slice(-tailChars);
}

/**
 * `node.getStart()` (and any comment/decorator range from ts's own trivia
 * scanner) skips PAST leading whitespace — so a slice taken from one of
 * these positions is missing the real indentation of its own first line
 * (every later line inside a multi-line slice keeps its indentation, since
 * that whitespace sits INSIDE the slice, not before it). Reattach it
 * explicitly wherever a fragment is emitted as a fresh line, rather than
 * threading a synthetic constant indent through recursive rendering — that
 * would either drop the file's real indent style (tabs, width) or double up
 * on top of a multi-line fragment's already-correct continuation lines.
 * Returns "" (no reattachment) if that span holds real code instead of pure
 * whitespace — e.g. an inline `class X { m() {} }` one-liner — so we never
 * duplicate other code onto its own line.
 */
function indentAtPos(source, pos) {
  const nl = source.lastIndexOf("\n", pos - 1);
  const lineStart = nl === -1 ? 0 : nl + 1;
  const span = source.slice(lineStart, pos);
  return /^[ \t]*$/.test(span) ? span : "";
}

function failSkeleton(reason, source) {
  return { skeleton: `/* ast-exact failed: ${reason} */\n${excerpt(source)}` };
}

// ---------------------------------------------------------------------------
// TypeScript / TSX / JS(X)
// ---------------------------------------------------------------------------

function scriptKindFor(lang) {
  if (lang === "ts") return ts.ScriptKind.TS;
  if (lang === "tsx") return ts.ScriptKind.TSX;
  return ts.ScriptKind.JSX; // "js" — superset covers plain .js/.mjs/.cjs too
}

function leadingDoc(node, sf, source, level) {
  if (level !== 1) return "";
  const fullStart = node.getFullStart();
  const ranges = ts.getLeadingCommentRanges(source, fullStart) || [];
  if (!ranges.length) return "";
  return ranges.map((r) => indentAtPos(source, r.pos) + source.slice(r.pos, r.end)).join("\n") + "\n";
}

function decoratorsText(node, sf, source, level) {
  if (level === 3) return "";
  let decs;
  try {
    decs = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  } catch {
    decs = undefined;
  }
  if (!decs || !decs.length) return "";
  return decs.map((d) => indentAtPos(source, d.getStart(sf)) + source.slice(d.getStart(sf), d.getEnd())).join("\n") + "\n";
}

/** Render a function-like node (FunctionDeclaration/MethodDeclaration/
 * Constructor/Accessor/FunctionExpression/ArrowFunction): signature verbatim,
 * body collapsed to a `{ /* ... N lines *\/ }` stub. */
function renderFunctionLike(node, sf, source, doc, decs) {
  const body = node.body;
  const sigEnd = body ? body.getStart(sf) : node.getEnd();
  const sig = (indentAtPos(source, node.getStart(sf)) + source.slice(node.getStart(sf), sigEnd)).trimEnd();
  if (!body) {
    return doc + decs + sig + (sig.endsWith(";") ? "" : ";");
  }
  if (ts.isBlock(body)) {
    const n = countLines(source.slice(body.getStart(sf), body.getEnd()));
    return doc + decs + sig + ` { /* … ${n} lines */ }`;
  }
  // concise arrow body (non-block expression)
  const bodyText = source.slice(body.getStart(sf), body.getEnd());
  if (bodyText.length <= SMALL_INIT_MAX && !bodyText.includes("\n")) {
    return doc + decs + sig + " " + bodyText;
  }
  const n = countLines(bodyText);
  return doc + decs + sig + ` /* … elided, ${n} lines */`;
}

/** Elide a variable/property initializer: verbatim if small & primitive,
 * else a visibly-marked stub. Function/arrow initializers get the same
 * signature+body-stub treatment as any other function-like node. */
function elideInitializer(init, sf, source) {
  const text = source.slice(init.getStart(sf), init.getEnd());
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return renderFunctionLike(init, sf, source, "", "");
  }
  if (ts.isObjectLiteralExpression(init)) {
    if (text.length <= SMALL_INIT_MAX && !text.includes("\n")) return text;
    const n = init.properties.length;
    const lines = countLines(text);
    return `{ /* … ${n} props, ${lines} lines */ }`;
  }
  if (ts.isArrayLiteralExpression(init)) {
    if (text.length <= SMALL_INIT_MAX && !text.includes("\n")) return text;
    const n = init.elements.length;
    return `[ /* … ${n} items */ ]`;
  }
  if (text.length <= SMALL_INIT_MAX && !text.includes("\n")) return text;
  return `/* … elided, ${text.length} chars */`;
}

function renderVarDeclarator(d, sf, source) {
  const nameAndType = d.type
    ? source.slice(d.name.getStart(sf), d.type.getEnd())
    : source.slice(d.name.getStart(sf), d.name.getEnd());
  if (!d.initializer) return nameAndType;
  return `${nameAndType} = ${elideInitializer(d.initializer, sf, source)}`;
}

function renderVariableStatement(stmt, sf, source, level) {
  const doc = leadingDoc(stmt, sf, source, level);
  const declList = stmt.declarationList;
  const prefix = indentAtPos(source, stmt.getStart(sf)) + source.slice(stmt.getStart(sf), declList.declarations[0].getStart(sf));
  const decls = declList.declarations.map((d) => renderVarDeclarator(d, sf, source));
  return doc + prefix + decls.join(", ") + ";";
}

function classHeaderBraceStart(node, sf, source) {
  const scanFrom = node.name ? node.name.getEnd() : node.getStart(sf);
  const idx = source.indexOf("{", scanFrom);
  return idx === -1 ? node.getEnd() : idx;
}

function memberName(m, sf, source) {
  if (!m.name) return "";
  return source.slice(m.name.getStart(sf), m.name.getEnd());
}

function isPrivateMember(m, name) {
  if (!name) return false;
  if (name.startsWith("#") || name.startsWith("_")) return true;
  const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
  return !!mods?.some((mm) => mm.kind === ts.SyntaxKind.PrivateKeyword);
}

function renderClassMember(m, sf, source, level) {
  if (ts.isSemicolonClassElement(m)) return null;
  const doc = leadingDoc(m, sf, source, level);
  const decs = decoratorsText(m, sf, source, level);
  if (
    ts.isMethodDeclaration(m) ||
    ts.isConstructorDeclaration(m) ||
    ts.isGetAccessorDeclaration(m) ||
    ts.isSetAccessorDeclaration(m)
  ) {
    return doc + decs + renderFunctionLike(m, sf, source, "", "");
  }
  if (ts.isPropertyDeclaration(m)) {
    // m.getStart(sf) is already post-decorator (decorators are sliced separately above).
    const base = m.type
      ? source.slice(m.getStart(sf), m.type.getEnd())
      : source.slice(m.getStart(sf), m.name.getEnd());
    const suffix = m.type ? "" : (m.questionToken ? "?" : "") + (m.exclamationToken ? "!" : "");
    if (!m.initializer) return doc + decs + base + suffix + ";";
    return doc + decs + base + suffix + " = " + elideInitializer(m.initializer, sf, source) + ";";
  }
  if (m.kind === ts.SyntaxKind.IndexSignature || ts.isIndexSignatureDeclaration(m)) {
    return doc + decs + source.slice(m.getStart(sf), m.getEnd()) + ";";
  }
  if (ts.isClassStaticBlockDeclaration && ts.isClassStaticBlockDeclaration(m)) {
    const n = countLines(source.slice(m.body.getStart(sf), m.body.getEnd()));
    return doc + `static { /* … ${n} lines */ }`;
  }
  // fallback: unknown member kind, keep verbatim if small else elide
  const text = source.slice(m.getStart(sf), m.getEnd());
  if (text.length <= 160 && !text.includes("\n")) return doc + decs + text;
  return doc + decs + `/* … member elided, ${countLines(text)} lines */`;
}

function renderClass(node, sf, source, level) {
  const doc = leadingDoc(node, sf, source, level);
  const decs = decoratorsText(node, sf, source, level);
  const braceStart = classHeaderBraceStart(node, sf, source);
  const header = source.slice(node.getStart(sf), braceStart).trimEnd() + " {";
  const lines = [doc + decs + header];
  for (const m of node.members) {
    const rendered = renderClassMember(m, sf, source, level);
    if (rendered === null) continue;
    for (const ln of rendered.split("\n")) lines.push("  " + ln);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderNamespace(node, sf, source, level) {
  const doc = leadingDoc(node, sf, source, level);
  if (!node.body || !ts.isModuleBlock(node.body)) {
    // ambient/declared namespace with no block body we can walk — keep verbatim
    return doc + source.slice(node.getStart(sf), node.getEnd());
  }
  const headerEnd = node.body.getStart(sf);
  const header = source.slice(node.getStart(sf), headerEnd).trimEnd() + " {";
  const lines = [doc + header];
  for (const stmt of node.body.statements) {
    const rendered = renderTopStatement(stmt, sf, source, level);
    if (rendered === null) continue;
    for (const ln of rendered.split("\n")) lines.push("  " + ln);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderGenericStatement(stmt, sf, source, level) {
  const doc = leadingDoc(stmt, sf, source, level);
  const text = source.slice(stmt.getStart(sf), stmt.getEnd());
  if (text.length <= 160 && !text.includes("\n")) return doc + text;
  const n = countLines(text);
  return doc + `/* … top-level statement elided, ${n} lines */`;
}

function renderTopStatement(stmt, sf, source, level) {
  if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
    const doc = leadingDoc(stmt, sf, source, level);
    return doc + source.slice(stmt.getStart(sf), stmt.getEnd());
  }
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
    const doc = leadingDoc(stmt, sf, source, level);
    return doc + source.slice(stmt.getStart(sf), stmt.getEnd());
  }
  if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    const doc = leadingDoc(stmt, sf, source, level);
    return doc + source.slice(stmt.getStart(sf), stmt.getEnd());
  }
  if (ts.isModuleDeclaration(stmt)) {
    return renderNamespace(stmt, sf, source, level);
  }
  if (ts.isClassDeclaration(stmt) || ts.isClassExpression(stmt)) {
    return renderClass(stmt, sf, source, level);
  }
  if (ts.isFunctionDeclaration(stmt)) {
    const doc = leadingDoc(stmt, sf, source, level);
    const decs = decoratorsText(stmt, sf, source, level);
    if (!stmt.body) {
      // overload signature — no body to elide
      return doc + decs + source.slice(stmt.getStart(sf), stmt.getEnd());
    }
    return doc + decs + renderFunctionLike(stmt, sf, source, "", "");
  }
  if (ts.isVariableStatement(stmt)) {
    return renderVariableStatement(stmt, sf, source, level);
  }
  return renderGenericStatement(stmt, sf, source, level);
}

function renderL1L2(sf, source, level) {
  const out = [];
  for (const stmt of sf.statements) {
    const rendered = renderTopStatement(stmt, sf, source, level);
    if (rendered !== null && rendered !== "") out.push(rendered);
  }
  return out.join("\n\n");
}

// ---------------------------------------------------------------------------
// L3 — API card
// ---------------------------------------------------------------------------

function isExportedStatement(stmt) {
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return true;
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function collapseSignatureOf(node, sf, source) {
  const end = node.body ? node.body.getStart(sf) : node.getEnd();
  return collapse(source.slice(node.getStart(sf), end));
}

function renderL3Member(m, sf, source) {
  if (ts.isSemicolonClassElement(m)) return null;
  if (
    ts.isMethodDeclaration(m) ||
    ts.isConstructorDeclaration(m) ||
    ts.isGetAccessorDeclaration(m) ||
    ts.isSetAccessorDeclaration(m)
  ) {
    return collapseSignatureOf(m, sf, source);
  }
  if (ts.isPropertyDeclaration(m)) {
    const base = m.type
      ? source.slice(m.getStart(sf), m.type.getEnd())
      : source.slice(m.getStart(sf), m.name.getEnd());
    return collapse(base);
  }
  if (m.kind === ts.SyntaxKind.IndexSignature || ts.isIndexSignatureDeclaration(m)) {
    return collapse(source.slice(m.getStart(sf), m.getEnd()));
  }
  return null;
}

function renderL3Class(node, sf, source) {
  const braceStart = classHeaderBraceStart(node, sf, source);
  const header = collapse(source.slice(node.getStart(sf), braceStart)) + " {";
  const lines = [header];
  let privateCount = 0;
  for (const m of node.members) {
    const name = memberName(m, sf, source);
    if (isPrivateMember(m, name)) {
      privateCount++;
      continue;
    }
    const rendered = renderL3Member(m, sf, source);
    if (rendered !== null) lines.push("  " + rendered);
  }
  if (privateCount) lines.push(`  // + ${privateCount} private members`);
  lines.push("}");
  return lines;
}

function renderL3VarDecl(stmt, d, sf, source) {
  const prefix = source.slice(stmt.getStart(sf), stmt.declarationList.declarations[0].getStart(sf));
  const init = d.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const sigEnd = init.body ? init.body.getStart(sf) : init.getEnd();
    const text = source.slice(d.getStart(sf), sigEnd);
    return collapse(prefix + text) + (ts.isArrowFunction(init) && init.body && ts.isBlock(init.body) ? " …" : "");
  }
  if (d.type) {
    return collapse(prefix + source.slice(d.getStart(sf), d.type.getEnd()));
  }
  return collapse(prefix + source.slice(d.name.getStart(sf), d.name.getEnd()));
}

function renderL3Statement(stmt, sf, source) {
  if (ts.isFunctionDeclaration(stmt)) {
    return [collapseSignatureOf(stmt, sf, source)];
  }
  if (ts.isClassDeclaration(stmt) || ts.isClassExpression(stmt)) {
    return renderL3Class(stmt, sf, source);
  }
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    return [collapse(source.slice(stmt.getStart(sf), stmt.getEnd()))];
  }
  if (ts.isModuleDeclaration(stmt)) {
    return [collapse(source.slice(stmt.getStart(sf), stmt.getEnd()))];
  }
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.map((d) => renderL3VarDecl(stmt, d, sf, source));
  }
  return [collapse(source.slice(stmt.getStart(sf), stmt.getEnd()))];
}

function renderL3(sf, source) {
  const imports = [];
  const lines = [];
  let internalCount = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : collapse(source.slice(stmt.getStart(sf), stmt.getEnd()));
      imports.push(spec);
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt)) {
      imports.push(collapse(source.slice(stmt.getStart(sf), stmt.getEnd())));
      continue;
    }
    if (!isExportedStatement(stmt)) {
      internalCount++;
      continue;
    }
    lines.push(...renderL3Statement(stmt, sf, source));
  }
  const out = [];
  if (imports.length) out.push(`// imports: ${imports.join(", ")}`);
  out.push(...lines);
  if (internalCount) out.push(`// + ${internalCount} internal declarations`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

function skeletonizeTs(path_, source, lang, level) {
  const sf = ts.createSourceFile(
    "input." + lang,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(lang),
  );
  const body = level === 3 ? renderL3(sf, source) : renderL1L2(sf, source, level);
  return { skeleton: body };
}

// ---------------------------------------------------------------------------
// Python (spawns py_skeleton.py)
// ---------------------------------------------------------------------------

function skeletonizePy(source, level) {
  const result = spawnSync("python3", [PY_HELPER], {
    input: JSON.stringify({ source, level }),
    encoding: "utf8",
    env: { PYTHONHASHSEED: "0", PATH: process.env.PATH || "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return failSkeleton(`python3 spawn error: ${result.error.message}`, source);
  }
  if (result.status !== 0) {
    return failSkeleton(`python3 exited ${result.status}: ${(result.stderr || "").slice(0, 300)}`, source);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return failSkeleton(`unparseable python helper output: ${e.message}`, source);
  }
  if (typeof parsed.skeleton !== "string") {
    return failSkeleton("python helper returned no skeleton field", source);
  }
  return { skeleton: parsed.skeleton };
}

// ---------------------------------------------------------------------------
// candidate export
// ---------------------------------------------------------------------------

const candidate = {
  id: "ast-exact",
  label: "AST-exact (TS compiler API + Python ast)",
  languages: ["ts", "tsx", "js", "py"],
  levels: [1, 2, 3],

  skeletonize(input) {
    const { path: p, source, lang, level } = input;
    try {
      if (lang === "ts" || lang === "tsx" || lang === "js") {
        return skeletonizeTs(p, source, lang, level);
      }
      if (lang === "py") {
        return skeletonizePy(source, level);
      }
      return failSkeleton(`unsupported lang "${lang}"`, source);
    } catch (e) {
      return failSkeleton(`${e && e.name ? e.name : "Error"}: ${e && e.message ? e.message : String(e)}`, source);
    }
  },
};

export default candidate;

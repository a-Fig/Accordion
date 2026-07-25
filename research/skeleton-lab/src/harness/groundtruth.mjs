/*
 * groundtruth.mjs — generates corpus/groundtruth.json from corpus/manifest.json
 * using REAL language parsers (never regex/heuristics on source text):
 *
 *   - ts / tsx / js : the `typescript` npm package's `ts.createSourceFile` +
 *     a hand-rolled AST walk over the resulting tree (no type checker, no
 *     program — pure syntactic parse, so it never needs a tsconfig and is
 *     total even over truncated/minified/malformed input, per ts's own
 *     error-tolerant parser).
 *   - py : the CPython stdlib `ast` module, run by spawning
 *     `python3 -c '<script>' <path>` (per the lab's explicit brief) and
 *     reading back one JSON object on stdout.
 *
 * Output shape (corpus/groundtruth.json):
 *   { "<manifest file path>": { "symbols": [ { name, kind, exported, line } ] } }
 *
 * Determinism: no Date/random/env-dependent text anywhere in the output;
 * symbols are sorted by (line, name) before being written.
 *
 * Run: node src/harness/groundtruth.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = path.resolve(HERE, "..", "..");
const MANIFEST_PATH = path.join(LAB_ROOT, "corpus", "manifest.json");
const GROUNDTRUTH_PATH = path.join(LAB_ROOT, "corpus", "groundtruth.json");

// ── shared ────────────────────────────────────────────────────────────────

function sortSymbols(symbols) {
  return [...symbols].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}

// ── TypeScript / TSX / JS (real parser: the `typescript` package) ─────────

const SCRIPT_KIND_FOR_LANG = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
};

/**
 * True iff the file never uses ES import/export syntax anywhere at the top
 * level — i.e. it's an ambient global "script" (TypeScript's own *.d.ts lib
 * files are exactly this shape: bare `interface Foo { ... }` / `declare var
 * X` with no import/export at all, which makes every top-level declaration
 * globally ambient — the closest real equivalent of "exported"). A normal
 * ES module (anything with at least one import/export) is NOT treated this
 * way; per-declaration `export` modifiers decide exported-ness instead.
 */
function isAmbientScript(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt)
    ) {
      return false;
    }
    if (ts.canHaveModifiers(stmt)) {
      const mods = ts.getModifiers(stmt);
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
    }
  }
  return true;
}

function hasModifier(node, kind) {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return !!mods?.some((m) => m.kind === kind);
}

function extractTsSymbols(source, lang) {
  const scriptKind = SCRIPT_KIND_FOR_LANG[lang] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    `input.${lang}`,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const ambient = isAmbientScript(sourceFile);
  const symbols = [];

  function lineOf(node) {
    try {
      return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    } catch {
      // Error-recovered nodes in badly truncated input can have a bogus
      // position; fall back to the node's raw (untrimmed-trivia) offset
      // rather than throwing — this generator must be total.
      return sourceFile.getLineAndCharacterOfPosition(Math.min(node.pos, source.length)).line + 1;
    }
  }

  function exportedOf(node) {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword) || ambient;
  }

  function collectClassMember(member, className, classExported) {
    let name = null;
    if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessor(member) ||
      ts.isSetAccessor(member)
    ) {
      if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
        name = member.name.text;
      }
    } else if (ts.isConstructorDeclaration(member)) {
      name = "constructor";
    }
    if (name == null) return;
    const isPrivate =
      hasModifier(member, ts.SyntaxKind.PrivateKeyword) || name.startsWith("#");
    symbols.push({
      name: `${className}.${name}`,
      kind: "method",
      exported: classExported && !isPrivate,
      line: lineOf(member),
    });
  }

  function collectStatements(statements) {
    for (const stmt of statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        const name = stmt.name ? stmt.name.text : "default";
        symbols.push({ name, kind: "function", exported: exportedOf(stmt), line: lineOf(stmt) });
      } else if (ts.isClassDeclaration(stmt)) {
        const className = stmt.name ? stmt.name.text : "default";
        const classExported = exportedOf(stmt);
        symbols.push({ name: className, kind: "class", exported: classExported, line: lineOf(stmt) });
        for (const member of stmt.members) {
          collectClassMember(member, className, classExported);
        }
      } else if (ts.isInterfaceDeclaration(stmt)) {
        symbols.push({
          name: stmt.name.text,
          kind: "interface",
          exported: exportedOf(stmt),
          line: lineOf(stmt),
        });
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        symbols.push({
          name: stmt.name.text,
          kind: "type",
          exported: exportedOf(stmt),
          line: lineOf(stmt),
        });
      } else if (ts.isEnumDeclaration(stmt)) {
        symbols.push({
          name: stmt.name.text,
          kind: "enum",
          exported: exportedOf(stmt),
          line: lineOf(stmt),
        });
      } else if (ts.isVariableStatement(stmt)) {
        const isConst = !!(stmt.declarationList.flags & ts.NodeFlags.Const);
        const kind = isConst ? "const" : "var";
        const exported = exportedOf(stmt);
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            symbols.push({ name: decl.name.text, kind, exported, line: lineOf(decl) });
          }
          // Destructuring declaration patterns (`const { a, b } = x`) are
          // intentionally skipped: no single declared name to report.
        }
      }
      // Namespaces/modules, ambient `declare module`, import/export
      // statements themselves: out of the requested symbol-kind vocabulary,
      // skipped by design.
    }
  }

  collectStatements(sourceFile.statements);
  return symbols;
}

// ── Python (real parser: CPython stdlib `ast`, via a spawned python3) ─────

const PY_AST_SCRIPT = `
import ast, json, sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
    src = f.read()

try:
    tree = ast.parse(src)
except SyntaxError:
    print(json.dumps({"symbols": []}))
    sys.exit(0)

# Module-level __all__, if present as a literal list/tuple of string constants.
all_names = None


def string_elts(node):
    if isinstance(node, (ast.List, ast.Tuple)):
        out = []
        for elt in node.elts:
            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                out.append(elt.value)
        return out
    return None


def scan_all(stmts):
    global all_names
    for node in stmts:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "__all__":
                    elts = string_elts(node.value)
                    if elts is not None:
                        all_names = set(elts)


scan_all(tree.body)


def is_exported(name):
    if name.startswith("_"):
        return False
    if all_names is not None:
        return name in all_names
    return True


symbols = []


def walk_class(node, prefix):
    qual = f"{prefix}.{node.name}" if prefix else node.name
    symbols.append(
        {"name": qual, "kind": "class", "exported": is_exported(node.name), "line": node.lineno}
    )
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append(
                {
                    "name": f"{qual}.{item.name}",
                    "kind": "method",
                    "exported": not item.name.startswith("_"),
                    "line": item.lineno,
                }
            )
        elif isinstance(item, ast.ClassDef):
            walk_class(item, qual)


def handle_stmt(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        symbols.append(
            {"name": node.name, "kind": "function", "exported": is_exported(node.name), "line": node.lineno}
        )
    elif isinstance(node, ast.ClassDef):
        walk_class(node, "")
    elif isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name):
                symbols.append(
                    {"name": t.id, "kind": "const", "exported": is_exported(t.id), "line": node.lineno}
                )
    elif isinstance(node, ast.AnnAssign):
        if isinstance(node.target, ast.Name):
            symbols.append(
                {
                    "name": node.target.id,
                    "kind": "const",
                    "exported": is_exported(node.target.id),
                    "line": node.lineno,
                }
            )
    elif isinstance(node, (ast.If, ast.Try)):
        # Conditional module-level definitions (the common
        # "try: import X except ImportError: def X(): ..." fallback
        # pattern, or "if sys.platform == ...: class Y: ..."). These are
        # real, reachable module-level symbols, so recurse into the
        # branches — but do NOT recurse into ordinary function/class
        # bodies elsewhere, which would incorrectly surface closures.
        for branch in (
            getattr(node, "body", []),
            getattr(node, "orelse", []),
            getattr(node, "finalbody", []),
        ):
            for sub in branch:
                handle_stmt(sub)
        for handler in getattr(node, "handlers", []):
            for sub in handler.body:
                handle_stmt(sub)


for node in tree.body:
    handle_stmt(node)

symbols.sort(key=lambda s: (s["line"], s["name"]))
print(json.dumps({"symbols": symbols}))
`;

function extractPySymbols(absPath) {
  const result = spawnSync("python3", ["-c", PY_AST_SCRIPT, absPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) {
    // Total per the contract: never throw, just report nothing found.
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed.symbols) ? parsed.symbols : [];
  } catch {
    return [];
  }
}

// ── driver ──────────────────────────────────────────────────────────────

async function main() {
  const manifestText = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(manifestText);

  const output = {};

  for (const entry of manifest) {
    const absPath = path.join(LAB_ROOT, entry.file);
    let symbols;

    if (entry.lang === "py") {
      symbols = extractPySymbols(absPath);
    } else if (entry.lang === "ts" || entry.lang === "tsx" || entry.lang === "js") {
      const source = await readFile(absPath, "utf8");
      symbols = extractTsSymbols(source, entry.lang);
    } else {
      symbols = [];
    }

    output[entry.file] = { symbols: sortSymbols(symbols) };
  }

  const json = JSON.stringify(output, null, 2) + "\n";
  await writeFile(GROUNDTRUTH_PATH, json, "utf8");

  const totalSymbols = Object.values(output).reduce((n, v) => n + v.symbols.length, 0);
  console.log(`wrote ${GROUNDTRUTH_PATH}`);
  console.log(`files: ${manifest.length}, total symbols: ${totalSymbols}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

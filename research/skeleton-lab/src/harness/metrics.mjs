/*
 * Pure metric functions for scoring a skeleton against its source and
 * ground-truth symbol list. No I/O except the two child-process spawns
 * (`ts.createProgram` runs in-process; Python validity spawns `python3`)
 * needed to check parseability — no filesystem/network access, no clocks,
 * no randomness. Determinism checking and timing live in run.mjs, since
 * those require calling the candidate twice / wrapping it with hrtime.
 */

import ts from "typescript";
import { spawnSync } from "node:child_process";

/** chars/4 estimate — kept as a single swappable function. */
export function tokens(text) {
  return Math.ceil((text ?? "").length / 4);
}

/** Size reduction from source to skeleton. */
export function reduction(src, skel) {
  const srcTokens = tokens(src);
  const skelTokens = tokens(skel);
  const ratio = srcTokens === 0 ? 0 : skelTokens / srcTokens;
  const removedPct = srcTokens === 0 ? 0 : (1 - ratio) * 100;
  return { srcTokens, skelTokens, ratio, removedPct };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `skeleton` contain evidence of `name`?
 * Plain names: word-boundary match anywhere.
 * "ClassName.method" names: the method part must match, AND the class name
 * must also appear earlier in the skeleton (so a `method` name floating in
 * an unrelated class doesn't count as a hit).
 */
function matchesSkeleton(skeleton, name) {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const className = name.slice(0, dot);
    const methodName = name.slice(dot + 1);
    const classRe = new RegExp(`\\b${escapeRegex(className)}\\b`);
    const classMatch = classRe.exec(skeleton);
    if (!classMatch) return false;
    const afterClass = skeleton.slice(classMatch.index + classMatch[0].length);
    const methodRe = new RegExp(`\\b${escapeRegex(methodName)}\\b`);
    return methodRe.test(afterClass);
  }
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
  return re.test(skeleton);
}

/**
 * Word-boundary signature recall of `symbols` (from groundtruth.json) inside
 * `skeleton`. Returns overall recall, exported-only recall, and up to 20
 * missing names.
 */
export function signatureRecall(skeleton, symbols) {
  const list = symbols ?? [];
  const results = list.map((sym) => ({
    ...sym,
    matched: matchesSkeleton(skeleton, sym.name),
  }));

  const total = results.length;
  const matched = results.filter((r) => r.matched).length;
  const missing = results.filter((r) => !r.matched).map((r) => r.name);

  const exportedResults = results.filter((r) => r.exported);
  const exportedTotal = exportedResults.length;
  const exportedMatched = exportedResults.filter((r) => r.matched).length;

  return {
    all: {
      matched,
      total,
      fraction: total === 0 ? 1 : matched / total,
    },
    exported: {
      matched: exportedMatched,
      total: exportedTotal,
      fraction: exportedTotal === 0 ? 1 : exportedMatched / exportedTotal,
    },
    missing: missing.slice(0, 20),
  };
}

function scriptKindFor(lang) {
  if (lang === "tsx") return ts.ScriptKind.TSX;
  if (lang === "ts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS; // js
}

function fileNameFor(lang) {
  if (lang === "tsx") return "skeleton.tsx";
  if (lang === "ts") return "skeleton.ts";
  return "skeleton.js";
}

function validityTsFamily(text, lang) {
  const fileName = fileNameFor(lang);
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(lang),
    );
  } catch {
    return { valid: false, errorCount: 1 };
  }

  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    jsx: lang === "tsx" ? ts.JsxEmit.Preserve : undefined,
  };
  const host = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? text : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  try {
    const program = ts.createProgram([fileName], compilerOptions, host);
    const diagnostics = program.getSyntacticDiagnostics(sourceFile);
    return { valid: diagnostics.length === 0, errorCount: diagnostics.length };
  } catch {
    return { valid: false, errorCount: 1 };
  }
}

function validityPy(text) {
  const res = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
    input: text,
    encoding: "utf8",
  });
  const valid = res.status === 0;
  return { valid, errorCount: valid ? 0 : 1 };
}

/**
 * Real parseability check. ts/tsx/js go through the TypeScript compiler's
 * syntactic diagnostics; py spawns `python3 -c "ast.parse(...)"` over stdin.
 *
 * A bare "…" (U+2026) elision marker is NOT valid outside a comment/string in
 * either language family — a skeleton that uses it standalone will score
 * invalid here. That's a real, intentional research finding, not a bug in
 * this checker. See validityLenient() below for the forgiving variant.
 */
export function validity(skeleton, lang) {
  if (lang === "ts" || lang === "tsx" || lang === "js") {
    return validityTsFamily(skeleton, lang);
  }
  if (lang === "py") {
    return validityPy(skeleton);
  }
  return { valid: false, errorCount: 0 };
}

const BARE_ELISION_LINE_RE = /^(#|\/\/)?\s*…+\s*$/;

/**
 * Sanitize elision markers before re-checking parseability:
 *  - a line that is ONLY an elision marker (bare "…", optionally already
 *    comment-prefixed) is stripped. For brace languages (ts/tsx/js) the
 *    line is dropped outright — the surrounding `{ }` tolerates an empty
 *    body just fine. Python's indentation-based suites do NOT tolerate an
 *    empty body (dropping the line would turn a real "…"-marker research
 *    finding into a spurious IndentationError unrelated to the marker
 *    question), so there the marker is replaced in place with Python's own
 *    "..." (Ellipsis) literal — exactly the valid stub the spec calls out.
 *  - any remaining inline "…" (mixed with real code on the same line) is
 *    replaced with a language-safe stand-in: "..." for .py, a block comment
 *    for ts/tsx/js so it can't swallow the rest of the line the way a `//`
 *    comment would.
 * This is a best-effort, check-only transform (it exists purely to answer
 * "would this parse if elision punctuation weren't the problem?"), not a
 * claim that the sanitized text is semantically equivalent to the original.
 */
function sanitizeElisionForLenient(skeleton, lang) {
  const isPy = lang === "py";
  const lines = skeleton
    .split("\n")
    .map((line) => {
      if (!BARE_ELISION_LINE_RE.test(line.trim())) return line;
      if (isPy) {
        const indent = line.match(/^\s*/)[0];
        return `${indent}...`;
      }
      return null; // drop entirely — empty braces/bodies are valid in ts/tsx/js
    })
    .filter((line) => line !== null);
  let sanitized = lines.join("\n");
  if (sanitized.includes("…")) {
    sanitized = isPy ? sanitized.split("…").join("...") : sanitized.split("…").join("/* … */");
  }
  return sanitized;
}

/**
 * validity() after stripping/neutralizing elision-marker punctuation.
 *
 * Lenient is monotone by definition: a skeleton that already parses strictly is
 * lenient-valid without running the sanitizer. (The sanitizer's blanket "…"
 * replacement can CORRUPT already-valid text — e.g. "…" inside a `/* … *​/`
 * comment becomes a nested comment that closes the outer one early — so it must
 * only ever be applied as a second chance for strictly-invalid skeletons.)
 */
export function validityLenient(skeleton, lang) {
  const strict = validity(skeleton, lang);
  if (strict.valid) return strict;
  return validity(sanitizeElisionForLenient(skeleton, lang), lang);
}

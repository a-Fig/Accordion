/*
 * core/conductors/doorman/skeletonize.ts
 *
 * Ported VERBATIM (structural logic byte-identical, only this banner comment rewritten)
 * from the deleted `conductors/code-skeleton/skeletonize.ts` (ADR 0016, git rev dc037bc)
 * for the "doorman" conductor — see `doorman.ts` for how it is wired to `classify.ts` and
 * the birth-fold exemption (ADR 0018).
 *
 * Deterministic, dependency-free "code skeleton" compression: turn a source file into a
 * structural interface view — imports/exports, type & interface declarations,
 * class/function/method SIGNATURES, decorators, docstrings/leading comments — with
 * implementation BODIES elided. Think ".ts → .d.ts" or ".py → signatures + docstrings".
 *
 * This module is SELF-CONTAINED string→string logic. It imports nothing — not the app,
 * not the conductor contract. Pure & deterministic: same input ⇒ byte-identical output.
 * No Date, no Math.random, no global state.
 *
 * The intellectual core is the MASK (see `maskSource`): a parallel copy of the source in
 * which the *contents* of string literals and comments are blanked to spaces (newlines and
 * length preserved, so indices line up 1:1 with the original). Structural analysis — brace
 * depth, indent, keyword matching — runs on the MASK; emitted lines come from the ORIGINAL.
 * This makes a `{` inside a string or a `}` inside a comment harmless.
 *
 * Bias: conservative correctness over maximal compression. When unsure, KEEP the line. We
 * never drop an import/export/top-level declaration/type/interface/signature — only clearly
 * bodied implementation is elided.
 */

export type Lang =
  | "ts"
  | "js"
  | "svelte"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "css"
  | "json"
  | "generic";

export interface SkeletonResult {
  /** The skeleton text (multi-line). NO fold tag, NO header line — just the structural skeleton. */
  skeleton: string;
  totalLines: number; // lines in the input
  keptLines: number; // structural lines kept verbatim
  elidedLines: number; // source lines collapsed into elision markers
}

/** Horizontal ellipsis (U+2026) — the canonical elision glyph used in every marker. */
const ELL = "…";

// ----------------------------------------------------------------------------------------
// detectLang
// ----------------------------------------------------------------------------------------

const EXT_LANG: Record<string, Lang> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  svelte: "svelte",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "java",
  kts: "java",
  c: "c",
  h: "c",
  cpp: "c",
  cc: "c",
  hpp: "c",
  cxx: "c",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
};

/** Lower-case file extension (without the dot), or "" if none. */
function extOf(path: string): string {
  // Strip any directory portion first so a dot in a folder name isn't mistaken for an ext.
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or a dotfile like ".gitignore"
  return base.slice(dot + 1).toLowerCase();
}

/** Pick a language from a file path (preferred) and/or a content sniff. Never throws. */
export function detectLang(path: string | undefined, text: string): Lang {
  if (path) {
    const ext = extOf(path);
    const byExt = EXT_LANG[ext];
    if (byExt) return byExt;
  }
  return sniffLang(text ?? "");
}

/** Content sniff used when the path is missing or its extension is unknown. */
function sniffLang(text: string): Lang {
  const head = text.slice(0, 4000);

  // Python: shebang, or `def `/`class ` paired with a trailing `:` somewhere.
  if (/^#!.*\bpython[0-9.]*\b/m.test(head)) return "python";
  const pyDef = /^[ \t]*(?:async[ \t]+)?def[ \t]+\w+\s*\(/m.test(head);
  const pyClass = /^[ \t]*class[ \t]+\w+\s*[(:]/m.test(head);
  if ((pyDef || pyClass) && /:\s*$/m.test(head)) return "python";

  // Rust: `fn name(` with braces, plus the very Rust-y `let mut`.
  if (/\bfn\s+\w+\s*\(/.test(head) && /\{/.test(head) && /\blet\s+mut\b/.test(head)) return "rust";

  // Go: `package X` plus a `func `.
  if (/^\s*package\s+\w+/m.test(head) && /\bfunc\s+/.test(head)) return "go";

  // TS/JS: any of the usual module/function shapes.
  if (
    /\bfunction\b/.test(head) ||
    /=>/.test(head) ||
    /\bconst\b/.test(head) ||
    /\bimport\b[\s\S]*\bfrom\b/.test(head)
  ) {
    return "ts";
  }

  return "generic";
}

// ----------------------------------------------------------------------------------------
// The mask — blank out string/comment CONTENTS, preserve positions & newlines.
// ----------------------------------------------------------------------------------------

export interface MaskOpts {
  /** `#` starts a line comment (Python). */
  hash?: boolean;
  /** `//` line + `/* *​/` block comments (C-family / JS / TS / Rust / Go / Java). */
  slash?: boolean;
  /** Backtick template literals (JS / TS). Treated as opaque strings. */
  backtick?: boolean;
  /** Triple-quoted strings `'''…'''` / `"""…"""` (Python docstrings). */
  triple?: boolean;
}

export const MASK_OPTS: Record<Lang, MaskOpts> = {
  ts: { slash: true, backtick: true },
  js: { slash: true, backtick: true },
  svelte: { slash: true, backtick: true },
  rust: { slash: true },
  go: { slash: true, backtick: true },
  java: { slash: true },
  c: { slash: true },
  css: { slash: true },
  json: {},
  python: { hash: true, triple: true },
  generic: { slash: true, hash: true, backtick: true },
};

/**
 * Build the structural mask. Returns a string of identical length to `src` where every
 * character that lives INSIDE a string literal or comment is replaced by a space, except
 * newlines (kept) — so `mask.length === src.length` and line/column indices match exactly.
 *
 * Single state machine; quotes/comments do not nest except block comments which we treat
 * as flat (C-family block comments don't nest in those languages anyway). Escapes inside
 * single/double-quoted strings are honoured so `"\""` doesn't end the string early.
 */
export function maskSource(src: string, opts: MaskOpts): string {
  const n = src.length;
  const out = new Array<string>(n);
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = src[k] === "\n" ? "\n" : " ";
  };
  const copy = (k: number) => {
    out[k] = src[k];
  };

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";

    // ---- line comments ----
    if (opts.slash && c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      copy(i); // keep the // markers visible (harmless, helps debugging) — but blank body
      copy(i + 1);
      blank(i + 2, j);
      i = j;
      continue;
    }
    if (opts.hash && c === "#") {
      let j = i + 1;
      while (j < n && src[j] !== "\n") j++;
      copy(i);
      blank(i + 1, j);
      i = j;
      continue;
    }

    // ---- block comments /* ... */ ----
    if (opts.slash && c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && j + 1 < n && src[j + 1] === "/")) j++;
      const end = j < n ? j + 2 : n; // include the closing */ if present
      copy(i);
      copy(i + 1);
      blank(i + 2, end);
      i = end;
      continue;
    }

    // ---- triple-quoted strings (Python) ----
    if (opts.triple && (c === '"' || c === "'") && src[i + 1] === c && src[i + 2] === c) {
      const q = c;
      let j = i + 3;
      while (j < n && !(src[j] === q && src[j + 1] === q && src[j + 2] === q)) j++;
      const end = j < n ? j + 3 : n;
      // keep the opening & closing triple-quote markers; blank the interior
      copy(i);
      copy(i + 1);
      copy(i + 2);
      blank(i + 3, Math.max(i + 3, end - 3));
      if (end - 3 >= i + 3 && end <= n) {
        if (end - 3 >= 0) copy(end - 3);
        if (end - 2 >= 0 && end - 2 < n) copy(end - 2);
        if (end - 1 >= 0 && end - 1 < n) copy(end - 1);
      }
      i = end;
      continue;
    }

    // ---- single / double quoted strings ----
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === "\\") j += 2;
        else j++;
      }
      const end = j < n ? j + 1 : n; // include closing quote if present
      copy(i); // keep the opening quote
      blank(i + 1, Math.max(i + 1, end - 1));
      if (end - 1 >= i + 1 && end <= n && src[end - 1] === q) copy(end - 1); // keep closing quote
      i = end;
      continue;
    }

    // ---- template literals (backtick) — opaque, no interpolation precision ----
    if (opts.backtick && c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") j += 2;
        else j++;
      }
      const end = j < n ? j + 1 : n;
      copy(i);
      blank(i + 1, Math.max(i + 1, end - 1));
      if (end - 1 >= i + 1 && end <= n && src[end - 1] === "`") copy(end - 1);
      i = end;
      continue;
    }

    // ---- ordinary character ----
    copy(i);
    i++;
  }

  return out.join("");
}

// ----------------------------------------------------------------------------------------
// Small line utilities (work over an array of original lines + matching mask lines).
// ----------------------------------------------------------------------------------------

function splitLines(s: string): string[] {
  // Keep it simple & lossless-enough for skeletons: split on \n, strip a trailing \r.
  return s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Net brace delta of a (masked) line: count of `{` minus `}`. */
function braceDelta(maskLine: string): number {
  let d = 0;
  for (const ch of maskLine) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

/** Leading-whitespace width (tabs counted as 1) of a line. */
function indentOf(line: string): number {
  let k = 0;
  while (k < line.length && (line[k] === " " || line[k] === "\t")) k++;
  return k;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

// ----------------------------------------------------------------------------------------
// skeletonize — dispatch
// ----------------------------------------------------------------------------------------

/** Produce a structural skeleton of already-clean source (no tool wrappers, no prefixes). */
export function skeletonize(src: string, lang: Lang): SkeletonResult {
  // Empty input: a degenerate-but-valid skeleton. (splitLines("") would otherwise yield one
  // empty "line", so short-circuit to keep counts honest at zero.)
  if (src.length === 0) {
    return { skeleton: "", totalLines: 0, keptLines: 0, elidedLines: 0 };
  }

  const totalLines = splitLines(src).length;

  let result: SkeletonResult;
  switch (lang) {
    case "ts":
    case "js":
    case "rust":
    case "go":
    case "java":
    case "c":
      result = skeletonizeBrace(src, lang);
      break;
    case "python":
      result = skeletonizePython(src);
      break;
    case "svelte":
      result = skeletonizeSvelte(src);
      break;
    case "css":
      result = skeletonizeCss(src);
      break;
    case "json":
      result = skeletonizeJson(src);
      break;
    case "generic":
    default:
      result = skeletonizeGeneric(src);
      break;
  }

  // Degenerate result: a known-language skeleton that didn't compress is returned AS-IS. We
  // must NEVER downgrade a known language to the generic head/tail fallback — that fallback
  // CHOPS the middle (fixed head/tail), which silently DROPS top-level declarations from an
  // all-contract file (a 36-export barrel, a `.d.ts`, a wide `interface`). Keeping every line
  // of an all-signatures file is the correct skeleton; the conductor independently declines to
  // skeletonize a file whose skeleton didn't shrink (via its own ratio / elidedLines checks).
  // The `generic` language IS the explicit fallback for genuinely unrecognized content, so it
  // keeps its head/tail behavior and is never re-substituted here.
  return { ...result, totalLines };
}

// ----------------------------------------------------------------------------------------
// Brace languages: ts, js, rust, go, java, c
// ----------------------------------------------------------------------------------------

/** A frame on the block stack — what kind of `{ … }` we're currently inside. */
type FrameKind = "container" | "callable" | "literal" | "other";
interface Frame {
  kind: FrameKind;
  depthAtOpen: number; // brace depth just BEFORE this block's `{`
}

// Container keywords: bodies hold member SIGNATURES we want to keep.
const CONTAINER_RE =
  /\b(class|interface|struct|enum|trait|impl|namespace|module)\b/;
// `interface`/`type` at the top level are kept whole (handled specially).

/** True if a (masked) line looks like the start of a callable whose body we should elide. */
function looksCallable(maskLine: string): boolean {
  const t = maskLine.trim();
  if (!t) return false;
  // Length guard FIRST: a real signature is short. The method-signature regex below
  // (`/…\([^;]*\)…$/`) backtracks catastrophically (O(n²)) on a long non-matching line — a
  // minified bundle, a data-URI literal, or generated code can be 100k+ chars on one line and
  // hang the conductor pass for tens of seconds. Anything this long is not a signature; bail
  // immediately so it's kept verbatim by the default-keep path.
  if (t.length > 2000) return false;
  // function / fn / func / method-ish + a parameter list, OR an arrow with a block.
  if (/\bfunction\b/.test(t)) return true;
  if (/\bfn\s+\w+/.test(t)) return true; // rust
  if (/\bfunc\b/.test(t)) return true; // go
  if (/\b(get|set)\s+\w+\s*\(/.test(t)) return true; // accessors
  if (/=>\s*\{?\s*$/.test(t) && /[([]/.test(t)) return true; // arrow w/ block on this/next line
  // method signature: `name(args) ... {` with no leading keyword that says container.
  if (/[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?::[^={]*)?\{?\s*$/.test(t)) {
    if (CONTAINER_RE.test(t)) return false;
    if (/^(if|for|while|switch|catch|do|else|return|with|match)\b/.test(t)) return false;
    return true;
  }
  return false;
}

function looksContainer(maskLine: string): boolean {
  const t = maskLine.trim();
  if (!t) return false;
  if (!CONTAINER_RE.test(t)) return false;
  // `import { … }` and `export { … }` use braces but are not containers.
  if (/^\s*(import|export)\b/.test(t) && !/\b(class|interface|enum|namespace|module|struct|trait|impl)\b/.test(t)) {
    return false;
  }
  return true;
}

/** A top-level `interface Foo { … }` / `type Foo = { … }` is kept whole (pure contract). */
function isTopLevelTypeDecl(maskLine: string): boolean {
  const t = maskLine.trim();
  return /^(export\s+)?(declare\s+)?(interface|type)\b/.test(t);
}

function isDecorator(maskLine: string): boolean {
  return /^\s*@[\w.]/.test(maskLine);
}

function isCommentLine(maskLine: string): boolean {
  const t = maskLine.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/");
}

function isImportExportLine(maskLine: string): boolean {
  const t = maskLine.trim();
  return /^(import|export)\b/.test(t) || /^(use|package|mod|pub\s+use|pub\s+mod)\b/.test(t);
}

function skeletonizeBrace(src: string, lang: Lang): SkeletonResult {
  const orig = splitLines(src);
  const mask = splitLines(maskSource(src, MASK_OPTS[lang]));
  const out: string[] = [];
  let kept = 0;
  let elided = 0;

  const stack: Frame[] = [];
  let depth = 0; // running brace depth (on the mask)

  // Are we currently inside a callable body that we are eliding? If so, skip until we pop
  // back to the depth at which the callable opened. `pendingHead` is the signature line that
  // opened the body (ending in its `{`); we hold it so the marker can be appended INSIDE the
  // kept braces (`sig { /* … N lines */ }`) instead of as a redundant second brace pair.
  let eliding = false;
  let elideTargetDepth = 0;
  let elideStartIdx = 0;
  let pendingHead = "";

  for (let i = 0; i < orig.length; i++) {
    const line = orig[i];
    const m = mask[i];

    if (eliding) {
      // Count down to the matching close brace using the mask.
      depth += braceDelta(m);
      if (depth <= elideTargetDepth) {
        // This line closes the callable body. Append the marker inside the held signature's
        // open brace, then any structure trailing the close `}` (e.g. `}, {` is rare; usually
        // just the bare close, which `pendingHead`'s `{` already balances).
        const nLines = i - elideStartIdx; // body lines collapsed (excludes the close line)
        const closeCol = m.indexOf("}");
        const afterClose = closeCol >= 0 ? line.slice(closeCol + 1).trimEnd() : "";
        out.push(`${pendingHead} ${ELL_MARK(nLines)} }${afterClose}`);
        elided += nLines;
        kept += 1; // the synthesized signature+marker line counts as kept structure
        eliding = false;
        pendingHead = "";
        // depth already updated; continue to next line.
        continue;
      }
      // still inside the body
      elided += 1;
      continue;
    }

    const trimmed = m.trim();
    const delta = braceDelta(m);

    // Blank lines: keep them only if they sit between kept structure — cheap, keep them.
    if (isBlank(line)) {
      out.push(line);
      kept += 1;
      depth += delta;
      continue;
    }

    // Top-level (depth 0, or inside a container) interface/type decl → keep WHOLE.
    if (isTopLevelTypeDecl(m) && (depth === 0 || (stack.length && stack[stack.length - 1].kind === "container"))) {
      // Keep the whole multi-line decl: walk until braces balance back to current depth and
      // any `;`-terminated single-line form ends. Simplest correct approach: emit lines while
      // depth (tracked) stays above the start, plus this opening line.
      const startDepth = depth;
      out.push(line);
      kept += 1;
      depth += delta;
      if (depth > startDepth) {
        // multi-line: keep until we come back down
        i++;
        for (; i < orig.length; i++) {
          out.push(orig[i]);
          kept += 1;
          depth += braceDelta(mask[i]);
          if (depth <= startDepth) break;
        }
      }
      continue;
    }

    // Decorators, comments, imports/exports, and bare top-level declarations: keep verbatim.
    // (But still account for any braces they open — rare, but a `const x = () => {` is caught
    //  by the callable check below, so these are genuinely body-less lines.)
    const isContainerHeader = looksContainer(m) && delta > 0;
    const callableHere = !isContainerHeader && looksCallable(m);

    if (isContainerHeader) {
      out.push(line);
      kept += 1;
      stack.push({ kind: "container", depthAtOpen: depth });
      depth += delta;
      // If a one-line container `class X {}` immediately closes, pop it.
      reconcileStack(stack, depth);
      continue;
    }

    if (callableHere) {
      // Signature may span multiple lines until the `{` that opens the body (or `;` for an
      // abstract/interface method / a forward decl → keep as-is, no body).
      // Find the opening brace for THIS callable on the mask, possibly on a later line.
      let openIdx = i;
      let sigDelta = delta;
      let hasBrace = m.includes("{");
      // If no brace yet and the line doesn't end the statement, gather continuation lines.
      while (!hasBrace && openIdx + 1 < orig.length && !/[;{]\s*$/.test(mask[openIdx].trimEnd()) && !mask[openIdx].includes(";")) {
        out.push(orig[openIdx]);
        kept += 1;
        openIdx++;
        sigDelta += 0; // braces counted when we actually see them below
        hasBrace = mask[openIdx].includes("{");
        if (hasBrace) break;
      }

      const sigLine = orig[openIdx];
      const sigMask = mask[openIdx];
      const sigBraceDelta = braceDelta(sigMask);

      if (!sigMask.includes("{")) {
        // No body (interface method, abstract, forward decl ending in `;`). Keep verbatim.
        out.push(sigLine);
        kept += 1;
        depth += sigBraceDelta;
        i = openIdx;
        continue;
      }

      // We have an opening brace on sigLine. Does the body also CLOSE on this same line?
      const afterOpen = depth + sigBraceDelta;
      const bodyBaseDepth = depth; // depth before the signature's own braces
      if (afterOpen <= bodyBaseDepth) {
        // one-liner like `fn x() {}` — keep whole, nothing to elide.
        out.push(sigLine);
        kept += 1;
        depth = afterOpen;
        i = openIdx;
        continue;
      }

      // Begin eliding the body. The kept "head" is the signature up to and including the `{`
      // that opens the body (everything after it on that line is body and gets elided).
      const braceCol = lastTopBraceCol(sigMask, bodyBaseDepth);
      const head = (braceCol >= 0 ? sigLine.slice(0, braceCol + 1) : sigLine).trimEnd();
      depth = afterOpen;
      elideTargetDepth = bodyBaseDepth;

      // Does the body also CLOSE later on this same signature line (e.g. `f() { return 1; }`)?
      const restMask = braceCol >= 0 ? " ".repeat(braceCol + 1) + sigMask.slice(braceCol + 1) : "";
      const restDelta = restMask ? braceDelta(restMask) : 0;
      if (restMask && depth + restDelta <= elideTargetDepth) {
        // One-line body after the brace. Collapse it: `sig { … }` (no line count — it's inline).
        const closeCol = restMask.indexOf("}");
        const afterClose = closeCol >= 0 ? sigLine.slice(closeCol + 1).trimEnd() : "";
        out.push(`${head} ${ELL} }${afterClose}`);
        kept += 1;
        depth += restDelta;
        i = openIdx;
        continue;
      }

      // Multi-line body: hold the head, elide following lines until the matching close.
      pendingHead = head;
      eliding = true;
      elideStartIdx = openIdx + 1;
      i = openIdx;
      continue;
    }

    // Large literal body: `const X = { … }` / `[ … ]` spanning > 6 lines.
    if (delta > 0 && isAssignmentOpening(m)) {
      const startDepth = depth;
      // Find matching close on the mask.
      let j = i;
      let d = depth;
      d += delta;
      while (d > startDepth && j + 1 < orig.length) {
        j++;
        d += braceDelta(mask[j]);
      }
      const span = j - i; // interior+close lines
      if (span > 6) {
        // Keep opener line up to and including the opening bracket; elide interior.
        const openCh = m.includes("{") ? "{" : "[";
        const closeCh = openCh === "{" ? "}" : "]";
        const openCol = lastTopBraceCol(m, startDepth, openCh);
        const head = openCol >= 0 ? line.slice(0, openCol + 1) : line;
        const interior = j - i - 1; // lines strictly inside
        out.push(`${head} ${ELL_MARK(interior)} ${closeCh}${tailAfterClose(orig[j], mask[j], closeCh)}`);
        kept += 1;
        elided += interior + 1; // interior + the close line we folded away
        depth = startDepth; // balanced
        i = j;
        continue;
      }
      // small literal: keep whole (fall through to default keep)
    }

    // Default: keep the line verbatim (imports/exports, decorators, comments, fields,
    // top-level const/let/var, container members that are plain signatures, `};`, etc.).
    out.push(line);
    kept += 1;
    depth += delta;
    reconcileStack(stack, depth);
    void isImportExportLine;
    void isDecorator;
    void isCommentLine;
  }

  // Truncated / unbalanced source: a callable body opened (`{`) but its closing `}` never
  // arrived (partial read, malformed source). `pendingHead` (the held signature) would
  // otherwise die unemitted and the whole declaration would be DROPPED. Flush it with a marker
  // so the signature survives. The body lines were already counted into `elided` line-by-line
  // in the eliding branch above, so don't re-add them; just emit the head + close.
  if (eliding) {
    out.push(`${pendingHead} ${ELL_MARK(orig.length - elideStartIdx)} }`);
    kept += 1;
    eliding = false;
    pendingHead = "";
  }

  return { skeleton: out.join("\n"), totalLines: orig.length, keptLines: kept, elidedLines: elided };
}

/** Pop container frames whose block has closed (depth fell back to/below where they opened). */
function reconcileStack(stack: Frame[], depth: number): void {
  while (stack.length && depth <= stack[stack.length - 1].depthAtOpen) stack.pop();
}

/** Leading whitespace of a line, as a string. */
function indentStr(line: string): string {
  return line.slice(0, indentOf(line));
}

/**
 * The INNER elision marker for brace languages: `/​* … N lines *​/` (or `/​* … *​/` for 0).
 * It is the comment that goes BETWEEN an already-kept brace pair, e.g. `sig { <here> }` — it
 * does not carry its own braces.
 */
function ELL_MARK(n: number): string {
  return n > 0 ? `/* ${ELL} ${n} ${n === 1 ? "line" : "lines"} */` : `/* ${ELL} */`;
}

/** Is this (masked) line an assignment that opens a `{`/`[` literal? */
function isAssignmentOpening(maskLine: string): boolean {
  const t = maskLine.trim();
  if (!/^(export\s+)?(default\s+)?(const|let|var|static|public|private|readonly|pub)?\b/.test(t)) {
    // still allow `Foo.bar = {` style
  }
  return /=\s*[{[]\s*$/.test(t) || /[:=]\s*[{[]\s*$/.test(t);
}

/**
 * Column of the `{` (or given char) that takes us from `baseDepth` to `baseDepth+1` — i.e.
 * the FIRST opening brace at the top level of this line. Returns -1 if none.
 */
function lastTopBraceCol(maskLine: string, baseDepth: number, open: string = "{"): number {
  let d = baseDepth;
  const close = open === "{" ? "}" : "]";
  for (let k = 0; k < maskLine.length; k++) {
    const ch = maskLine[k];
    if (ch === open) {
      if (d === baseDepth) return k;
      d++;
    } else if (ch === close) {
      d--;
    } else if (ch === "{") {
      d++;
    } else if (ch === "}") {
      d--;
    }
  }
  return -1;
}

/** Anything after the closing bracket on a folded-literal close line (e.g. `};` → `;`). */
function tailAfterClose(origLine: string, maskLine: string, closeCh: string): string {
  const col = maskLine.lastIndexOf(closeCh);
  if (col < 0) return "";
  const tail = origLine.slice(col + 1);
  return tail.trimEnd();
}

// ----------------------------------------------------------------------------------------
// Python — indentation based
// ----------------------------------------------------------------------------------------

function skeletonizePython(src: string): SkeletonResult {
  const orig = splitLines(src);
  const mask = splitLines(maskSource(src, MASK_OPTS.python));
  const out: string[] = [];
  let kept = 0;
  let elided = 0;

  let i = 0;
  while (i < orig.length) {
    const line = orig[i];
    const m = mask[i];

    if (isBlank(line)) {
      out.push(line);
      kept += 1;
      i++;
      continue;
    }

    const t = m.trim();
    const isDef = /^(async\s+)?def\s+\w+/.test(t);

    if (isDef) {
      const defIndent = indentOf(line);
      // Keep the (possibly multi-line) signature: lines until the one whose masked text ends
      // with `:` at this paren depth. Track parens on the mask to find the real end.
      let j = i;
      let parens = 0;
      let sawColonEnd = false;
      for (; j < orig.length; j++) {
        out.push(orig[j]);
        kept += 1;
        for (const ch of mask[j]) {
          if (ch === "(" || ch === "[" || ch === "{") parens++;
          else if (ch === ")" || ch === "]" || ch === "}") parens--;
        }
        const mj = mask[j].replace(/\s+$/, "");
        if (parens <= 0 && mj.endsWith(":")) {
          sawColonEnd = true;
          break;
        }
        if (parens <= 0 && /:\s*\S/.test(mask[j]) && j === i) {
          // single-line `def f(): body` — handled by body scan below
          sawColonEnd = true;
          break;
        }
      }
      void sawColonEnd;

      // Body starts at j+1. Find the first non-blank line and confirm it's more-indented.
      let b = j + 1;
      // Capture a leading docstring (the first statement) and keep it.
      // Skip blank lines first (but don't emit them yet — emit once we know there's a body).
      let firstBody = b;
      while (firstBody < orig.length && isBlank(orig[firstBody])) firstBody++;

      if (firstBody >= orig.length || indentOf(orig[firstBody]) <= defIndent) {
        // No indented body (e.g. `def f(): ...` one-liner, or stub). If the signature line
        // itself had inline body after the colon, we already kept it. Nothing to elide.
        i = j + 1;
        continue;
      }

      // Reuse the body's ACTUAL leading-whitespace STRING for the stub indent. indentOf counts
      // a tab as width 1, so rebuilding indent from a width with spaces mis-indents a
      // tab-indented body (a single tab → a single space). Capture the real prefix instead.
      const bodyIndentStr = orig[firstBody].slice(0, indentOf(orig[firstBody]));

      // Emit any blank lines between sig and body? Skip them (collapse). Keep a docstring.
      let cursor = firstBody;
      let keptDocstring = false;
      const dtrim = mask[cursor].trim();
      if (dtrim.startsWith('"""') || dtrim.startsWith("'''") || /^[rbRBuU]?["']/.test(orig[cursor].trim())) {
        // Determine the docstring's line span via the mask triple-quote handling: walk until
        // the quotes balance. Simplest: if it's a triple-quote, find the closing triple.
        const q3 = dtrim.startsWith('"""') ? '"""' : dtrim.startsWith("'''") ? "'''" : "";
        if (q3) {
          let e = cursor;
          // single-line docstring?
          const rest = orig[cursor].trim().slice(3);
          if (rest.includes(q3)) {
            out.push(orig[cursor]);
            kept += 1;
            keptDocstring = true;
            e = cursor;
          } else {
            for (e = cursor; e < orig.length; e++) {
              out.push(orig[e]);
              kept += 1;
              if (e > cursor && orig[e].includes(q3)) break;
              if (e === cursor) continue;
            }
            keptDocstring = true;
          }
          cursor = e + 1;
        } else {
          // single/double quoted one-line docstring
          out.push(orig[cursor]);
          kept += 1;
          keptDocstring = true;
          cursor = cursor + 1;
        }
      }

      // Now elide the remainder of the body: every line indented > defIndent.
      let bodyEnd = cursor;
      while (bodyEnd < orig.length) {
        if (isBlank(orig[bodyEnd])) {
          bodyEnd++;
          continue;
        }
        if (indentOf(orig[bodyEnd]) <= defIndent) break;
        bodyEnd++;
      }
      const elidedCount = countNonBlank(orig, cursor, bodyEnd);
      if (elidedCount > 0) {
        out.push(`${bodyIndentStr}...  # ${ELL} ${elidedCount} ${elidedCount === 1 ? "line" : "lines"}`);
        kept += 1; // the `...` stub line
        elided += elidedCount;
      } else if (!keptDocstring) {
        // empty/whitespace body with no docstring: emit a bare stub so it's valid.
        out.push(`${bodyIndentStr}...`);
        kept += 1;
      }
      i = bodyEnd;
      continue;
    }

    // Non-def line: keep verbatim (imports, module statements, class headers, decorators,
    // assignments, `if __name__`, etc.). Class bodies are walked line-by-line so their
    // method `def`s are caught by the branch above.
    out.push(line);
    kept += 1;
    i++;
  }

  return { skeleton: out.join("\n"), totalLines: orig.length, keptLines: kept, elidedLines: elided };
}

function countNonBlank(lines: string[], from: number, to: number): number {
  let c = 0;
  for (let k = from; k < to; k++) if (!isBlank(lines[k])) c++;
  return c;
}

// ----------------------------------------------------------------------------------------
// Svelte — <script> skeletonized as ts; template + style collapsed.
// ----------------------------------------------------------------------------------------

function skeletonizeSvelte(src: string): SkeletonResult {
  const orig = splitLines(src);
  const total = orig.length;
  const mask = maskSource(src, MASK_OPTS.svelte);

  // Find <script …>…</script> and <style …>…</style> spans on the (lowercased) source.
  // Use a case-insensitive scan on the raw text (tags aren't inside strings normally).
  const lower = src.toLowerCase();

  interface Span {
    kind: "script" | "style";
    openStart: number; // index of '<'
    openEnd: number; // index just after '>'
    closeStart: number; // index of '<' of closing tag
    closeEnd: number; // index just after '>'
  }
  const spans: Span[] = [];
  for (const tag of ["script", "style"] as const) {
    let from = 0;
    for (;;) {
      const open = lower.indexOf(`<${tag}`, from);
      if (open < 0) break;
      const openGt = lower.indexOf(">", open);
      if (openGt < 0) break;
      const close = lower.indexOf(`</${tag}`, openGt);
      if (close < 0) break;
      const closeGt = lower.indexOf(">", close);
      if (closeGt < 0) break;
      spans.push({ kind: tag, openStart: open, openEnd: openGt + 1, closeStart: close, closeEnd: closeGt + 1 });
      from = closeGt + 1;
    }
  }
  spans.sort((a, b) => a.openStart - b.openStart);

  const out: string[] = [];
  // Track only what we actually COLLAPSED (template lines + each script's elided body lines +
  // style lines). `keptLines` is then derived as `total - elided` (clamped ≥ 0) so the counts
  // are always honest — `keptLines <= totalLines`. Summing per-part kept counts double-counted
  // the open/close-tag boundary lines (they overlap the script's own line span), which could
  // push `keptLines` ABOVE `totalLines` and render nonsense like `5L → 7L` in the header.
  let elided = 0;

  let pos = 0;
  const emitTemplate = (from: number, to: number) => {
    const chunk = src.slice(from, to);
    const maskChunk = mask.slice(from, to);
    const lines = splitLines(chunk).filter((l) => !isBlank(l));
    if (lines.length === 0) return;
    // Count elements: `<` in the MASK that begin a tag (followed by a letter or `/`).
    let elements = 0;
    for (let k = 0; k < maskChunk.length; k++) {
      if (maskChunk[k] === "<" && /[A-Za-z/!]/.test(maskChunk[k + 1] ?? "")) elements++;
    }
    out.push(`<!-- template ${"·"} ${lines.length} ${lines.length === 1 ? "line" : "lines"} ${"·"} ${elements} ${elements === 1 ? "element" : "elements"} -->`);
    elided += lines.length;
  };

  for (const sp of spans) {
    if (sp.openStart > pos) emitTemplate(pos, sp.openStart);

    const openTag = src.slice(sp.openStart, sp.openEnd);
    const inner = src.slice(sp.openEnd, sp.closeStart);
    const closeTag = src.slice(sp.closeStart, sp.closeEnd);

    if (sp.kind === "script") {
      out.push(openTag.trim());
      const sub = skeletonizeBrace(inner, "ts");
      // Re-indent nothing; keep the script body as-is.
      if (sub.skeleton.trim().length) {
        out.push(sub.skeleton.replace(/^\n+|\n+$/g, ""));
      }
      elided += sub.elidedLines;
      out.push(closeTag.trim());
    } else {
      const styleLines = splitLines(inner).filter((l) => !isBlank(l)).length;
      out.push(`${openTag.trim()}/* ${ELL} ${styleLines} ${styleLines === 1 ? "line" : "lines"} */${closeTag.trim()}`);
      elided += styleLines;
    }
    pos = sp.closeEnd;
  }
  if (pos < src.length) emitTemplate(pos, src.length);

  const keptLines = Math.max(0, total - elided);
  return { skeleton: out.join("\n"), totalLines: total, keptLines, elidedLines: elided };
}

// ----------------------------------------------------------------------------------------
// CSS — keep each selector/at-rule header; collapse each rule body to `{ … }`.
// ----------------------------------------------------------------------------------------

function skeletonizeCss(src: string): SkeletonResult {
  const orig = splitLines(src);
  const mask = splitLines(maskSource(src, MASK_OPTS.css));
  const out: string[] = [];
  let kept = 0;
  let elided = 0;

  let depth = 0;
  let i = 0;
  while (i < orig.length) {
    const line = orig[i];
    const m = mask[i];

    if (isBlank(line)) {
      out.push(line);
      kept += 1;
      i++;
      continue;
    }

    // @import / @charset etc. (no body) and bare lines at depth 0 that don't open a block.
    const delta = braceDelta(m);

    if (delta > 0) {
      // This line opens a rule (selector or at-rule header). Keep the header up to `{`,
      // collapse the interior to ` { … }`, and skip to the matching close.
      const startDepth = depth;
      const openCol = lastTopBraceCol(m, startDepth, "{");
      const header = openCol >= 0 ? line.slice(0, openCol).trimEnd() : line.trimEnd();

      // Is this an at-rule that nests other rules (@media/@supports)? Keep header + recurse
      // shallowly: we just collapse its whole body to `{ … }` for simplicity & determinism.
      let j = i;
      let d = startDepth + delta;
      let firstBraceMoreContent = m.slice(openCol + 1);
      void firstBraceMoreContent;
      while (d > startDepth && j + 1 < orig.length) {
        j++;
        d += braceDelta(mask[j]);
      }
      const interior = countNonBlank(orig, i + 1, j); // lines strictly inside (excl. close)
      const sameLine = i === j;
      if (sameLine) {
        out.push(`${header} { ${ELL} }`);
      } else {
        out.push(`${header} { ${ELL} }`);
      }
      kept += 1;
      elided += interior + (sameLine ? 0 : 1);
      depth = startDepth;
      i = j + 1;
      continue;
    }

    // No brace on this line: a top-level statement (@import "x"; etc.) — keep verbatim.
    out.push(line);
    kept += 1;
    depth += delta;
    i++;
  }

  return { skeleton: out.join("\n"), totalLines: orig.length, keptLines: kept, elidedLines: elided };
}

// ----------------------------------------------------------------------------------------
// JSON — keep the shape one level deep; elide deeper objects/arrays.
// ----------------------------------------------------------------------------------------

function skeletonizeJson(src: string): SkeletonResult {
  const orig = splitLines(src);
  // Best-effort: parse and re-emit one level deep. If parsing fails, fall through to generic.
  try {
    const value = JSON.parse(src);
    const skeleton = jsonShape(value);
    const keptLines = splitLines(skeleton).length;
    return {
      skeleton,
      totalLines: orig.length,
      keptLines,
      elidedLines: Math.max(0, orig.length - keptLines),
    };
  } catch {
    return skeletonizeGeneric(src);
  }
}

function jsonShape(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[ ${ELL} ${value.length} ${value.length === 1 ? "item" : "items"} ]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const parts = keys.map((k) => `  ${JSON.stringify(k)}: ${jsonShapeChild(obj[k])}`);
  return `{\n${parts.join(",\n")}\n}`;
}

/** One level down: scalars verbatim; nested object/array → a typed elision placeholder. */
function jsonShapeChild(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[ ${ELL} ${value.length} ${value.length === 1 ? "item" : "items"} ]`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 0 ? "{}" : `{ ${ELL} ${keys.length} ${keys.length === 1 ? "key" : "keys"} }`;
}

// ----------------------------------------------------------------------------------------
// Generic fallback — head/tail with a middle elision marker. Always safe.
// ----------------------------------------------------------------------------------------

const GENERIC_HEAD = 24;
const GENERIC_TAIL = 8;

function skeletonizeGeneric(src: string): SkeletonResult {
  const orig = splitLines(src);
  const total = orig.length;

  // Index the non-trivial (non-blank) lines so head/tail are meaningful.
  const nonTrivialIdx: number[] = [];
  for (let i = 0; i < orig.length; i++) if (!isBlank(orig[i])) nonTrivialIdx.push(i);

  if (nonTrivialIdx.length <= GENERIC_HEAD + GENERIC_TAIL) {
    // Nothing to elide — return as-is (still a valid skeleton).
    return { skeleton: orig.join("\n"), totalLines: total, keptLines: orig.length, elidedLines: 0 };
  }

  const headCut = nonTrivialIdx[GENERIC_HEAD - 1]; // last kept head line (original index)
  const tailStart = nonTrivialIdx[nonTrivialIdx.length - GENERIC_TAIL]; // first kept tail line

  const out: string[] = [];
  let kept = 0;
  for (let i = 0; i <= headCut; i++) {
    out.push(orig[i]);
    kept++;
  }
  const elidedCount = countNonBlank(orig, headCut + 1, tailStart);
  out.push(`${ELL} ⟨${elidedCount} lines elided — unfold for full source⟩ ${ELL}`);
  kept++; // marker line
  for (let i = tailStart; i < orig.length; i++) {
    out.push(orig[i]);
    kept++;
  }

  return { skeleton: out.join("\n"), totalLines: total, keptLines: kept, elidedLines: elidedCount };
}

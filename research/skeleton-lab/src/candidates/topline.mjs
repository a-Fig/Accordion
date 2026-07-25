/*
 * topline — dependency-free LINE-RANKING skeletonizer.
 *
 * Deliberately NOT a brace-matcher / AST walker. Topline never parses structure;
 * it scores every line of the source with a small set of deterministic regex
 * signals plus indentation/length penalties, then either:
 *
 *   (a) thresholds the score against a per-level target reduction, implemented
 *       as a TOKEN BUDGET (see BUDGET_PRESET) so the reduction ratio is
 *       guaranteed rather than hoped for, or
 *   (b) (bonus API) fills an arbitrary caller-supplied token budget with the
 *       top-scored lines — a smooth compression dial no threshold scheme gives
 *       you.
 *
 * Both paths share one core: score() -> select() -> render(). Kept lines are
 * emitted byte-identical (original indentation, original text) in original
 * order; dropped runs become a single elision marker in the file's comment
 * syntax: `// ⋯ (N lines)` / `# ⋯ (N lines)`.
 *
 * SCORING TABLE (pre-penalty base weights; see WEIGHTS below):
 *   band          score   notes
 *   def           100     function/class/interface/enum/type-alias headers (JS/TS), def/class (py)
 *   io             92     import / export / from statements
 *   decorator      85     `@...` lines
 *   method         82     class-member access-modifier signatures (public/private/static/...)
 *   methodBare     76     bare `name(...) {` method-shorthand signatures
 *   doc            78     docstring / doc-comment OPENER line (/** , """, #!, shebang)
 *   field          50     `name: Type;`-shaped property/annotation lines
 *   comment        45     plain // or # line comments
 *   body           20     everything else (baseline, then penalized)
 *   close           3     a line that is only closing punctuation ()/]/};/,/)
 *   data            1     a single line > DATA_LINE_CHARS (treated as unparsed data)
 *   blank           0
 *
 * Two zeroing rules apply only to the LEVEL-based `skeletonize()` entry point
 * (the raw `skeletonizeToBudget()` bonus API never zeroes anything — it has no
 * level to key off of):
 *   - L2 and L3 zero the `doc` and `comment` bands (score -> ~1-2, hard-excluded).
 *   - L3 additionally zeroes `def`/`method`/`methodBare`/`field` lines that look
 *     private/non-exported (JS/TS: no literal `export` on the line; Python: the
 *     symbol name starts with `_` and isn't a dunder `__x__`).
 *
 * A `def`/`io`/`decorator`/`method`/`methodBare` line whose parens/brackets are
 * left open carries its score onto the following physical lines until they
 * close, so a multi-line signature (or a multi-line `import { ... } from`)
 * survives or drops as one unit. `io` also tracks `{ }` (destructured import
 * lists); the others deliberately do NOT track `{ }`, so a function's opening
 * body brace does not drag the whole body along.  A `doc`/block-comment opener
 * that isn't closed on its own line likewise carries until the closing token
 * (`*\/`, matching `"""`/`'''`) is seen, so a whole docstring is one unit for
 * scoring purposes (even though its interior lines can still be individually
 * elided if the budget is tight — see "known weaknesses" in the report).
 *
 * SAFETY RAILS:
 *   - any line longer than DATA_LINE_CHARS (2000) skips ALL regex work and is
 *     scored as `data`; if such a line is ever kept, it renders as a head-200
 *     truncation, so a single giant minified line can never blow up runtime or
 *     output size.
 *   - CRLF/CR line endings are normalized before splitting; tabs are expanded
 *     (for indent-penalty measurement only — original bytes are still emitted
 *     verbatim for every kept line).
 *   - the whole public surface is wrapped in try/catch; on ANY exception the
 *     module falls back to a dumb, regex-free head/tail excerpt rather than
 *     throwing (the contract scores a throw as a hard failure).
 *   - fully deterministic: no Date, no Math.random, no environment-derived
 *     text; ties in budget ranking break on ascending original line number.
 */

const LANGS = ["ts", "tsx", "js", "py"];
const LEVELS = [1, 2, 3];

// L1 keeps ~1/4 of the source, L2 ~1/8, L3 ~1/20 — see BONUS API note above:
// these are just the "keep filling until this many tokens" targets that back
// the level dial; the must-keep band (`io`/`def`) always survives regardless.
const BUDGET_PRESET = { 1: 0.25, 2: 0.12, 3: 0.05 };

const DATA_LINE_CHARS = 2000;
const TRUNCATE_HEAD_CHARS = 200;

const WEIGHTS = {
  def: 100,
  io: 92,
  decorator: 85,
  method: 82,
  methodBare: 76,
  doc: 78,
  field: 50,
  comment: 45,
  body: 20,
  close: 3,
  data: 1,
  blank: 0,
};

const ZEROED_DOC_SCORE = 2;
const ZEROED_COMMENT_SCORE = 1;
const ZEROED_PRIVATE_SCORE = 8;

// Bands that force-keep regardless of budget (the level-3 privacy zeroing, if
// it fires, strips a line OUT of this set — see classify()/applyLevel()).
const FORCE_KEEP_BANDS = new Set(["io", "def"]);

// Bands whose (), [] can carry an "unbalanced -> continues next line" state so
// a wrapped signature survives as one unit. `io` additionally tracks {}.
const CARRY_BANDS = new Set(["io", "def", "decorator", "method", "methodBare"]);

// ---------------------------------------------------------------------------
// regexes (all anchored, no nested quantifiers -> no catastrophic backtrack)
// ---------------------------------------------------------------------------

const RE = {
  blank: /^\s*$/,
  shebang: /^#!/,
  closingOnly: /^[)\]}\s;,]+$/,

  // JS/TS family
  jsDocOpen: /^\/\*\*/,
  jsBlockCommentOpen: /^\/\*/,
  jsLineComment: /^\/\//,
  jsImportExport: /^(?:import|export)\b/,
  jsDef: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|class\b|interface\b|enum\b)/,
  jsTypeAlias: /^(?:export\s+)?type\s+[A-Za-z_$][\w$]*/,
  jsDecl: /^(?:export\s+)?(?:const|let|var)\b/,
  jsDecorator: /^@\S/,
  jsAccessModifier: /^(?:public|private|protected|static|readonly|abstract)\b/,
  jsBareMethod: /^[A-Za-z_$][\w$]*\s*\([^()]*\)\s*(?::\s*[^{;=]+)?\s*\{\s*$/,
  jsFieldSig: /^[A-Za-z_$][\w$]*\??\s*:\s*.+$/,
  jsHasExport: /\bexport\b/,

  // Python
  pyLineComment: /^#/,
  pyDocOpen: /^(?:[rRuUbBfF]{1,2})?("""|''')/,
  pyImport: /^(?:import|from)\b/,
  pyDef: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  pyClass: /^class\s+([A-Za-z_]\w*)/,
  pyDecorator: /^@\S/,
};

function isPyLang(lang) {
  return lang === "py";
}

function commentTokenFor(lang) {
  return isPyLang(lang) ? "#" : "//";
}

function countTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function expandedIndentUnits(raw) {
  let units = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === " ") units += 1;
    else if (c === "\t") units += 4;
    else break;
  }
  return units;
}

function bracketDelta(line, includeBraces) {
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "(" || c === "[") d++;
    else if (c === ")" || c === "]") d--;
    else if (includeBraces) {
      if (c === "{") d++;
      else if (c === "}") d--;
    }
  }
  return d;
}

function isPrivateJsLine(trimmed) {
  return !RE.jsHasExport.test(trimmed);
}

function isPrivatePyName(name) {
  if (!name) return false;
  if (/^__\w+__$/.test(name)) return false; // dunder: treat as public API
  return name.startsWith("_");
}

/**
 * Classify one physical line in isolation (no cross-line state). Returns
 * { band, score, tokens, len, forceable, privateName } where `privateName` is
 * the best-effort symbol name used by the L3 zeroing rule (null if n/a).
 */
function classifyLine(raw, lang) {
  const len = raw.length;
  if (RE.blank.test(raw)) {
    return { band: "blank", score: WEIGHTS.blank, len, privateName: null };
  }
  if (len > DATA_LINE_CHARS) {
    return { band: "data", score: WEIGHTS.data, len, privateName: null };
  }

  const trimmed = raw.trim();

  if (RE.shebang.test(trimmed)) {
    return { band: "doc", score: WEIGHTS.doc, len, privateName: null };
  }

  if (isPyLang(lang)) {
    const mDoc = RE.pyDocOpen.exec(trimmed);
    if (mDoc) {
      return { band: "doc", score: WEIGHTS.doc, len, privateName: null, quoteToken: mDoc[1] };
    }
    if (RE.pyLineComment.test(trimmed)) {
      return { band: "comment", score: WEIGHTS.comment, len, privateName: null };
    }
    if (RE.pyImport.test(trimmed)) {
      return { band: "io", score: WEIGHTS.io, len, privateName: null };
    }
    const mDef = RE.pyDef.exec(trimmed);
    if (mDef) {
      return { band: "def", score: WEIGHTS.def, len, privateName: mDef[1] };
    }
    const mClass = RE.pyClass.exec(trimmed);
    if (mClass) {
      return { band: "def", score: WEIGHTS.def, len, privateName: mClass[1] };
    }
    if (RE.pyDecorator.test(trimmed)) {
      return { band: "decorator", score: WEIGHTS.decorator, len, privateName: null };
    }
    if (RE.closingOnly.test(trimmed)) {
      return { band: "close", score: WEIGHTS.close, len, privateName: null };
    }
    if (RE.jsFieldSig.test(trimmed)) {
      // python type-annotated assignment / dict-literal-key line, best-effort
      return { band: "field", score: WEIGHTS.field, len, privateName: null };
    }
    return { band: "body", score: WEIGHTS.body, len, privateName: null };
  }

  // JS / TS / TSX family
  if (RE.jsDocOpen.test(trimmed)) {
    return { band: "doc", score: WEIGHTS.doc, len, privateName: null, closeToken: "*/" };
  }
  if (RE.jsBlockCommentOpen.test(trimmed)) {
    return { band: "comment", score: WEIGHTS.comment, len, privateName: null, closeToken: "*/" };
  }
  if (RE.jsLineComment.test(trimmed)) {
    return { band: "comment", score: WEIGHTS.comment, len, privateName: null };
  }
  // NOTE: def/typeAlias/decl MUST be checked before the generic jsImportExport
  // catch-all — `export interface Foo {`, `export const x`, `export type T`
  // all start with the literal word "export" and would otherwise be
  // misclassified as the (brace-tracking) `io` band, which then swallows the
  // ENTIRE declaration body as an "unclosed import" continuation.
  if (RE.jsDef.test(trimmed)) {
    const m = /(?:function|class|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    return { band: "def", score: WEIGHTS.def, len, privateName: m ? m[1] : null, trimmed };
  }
  if (RE.jsTypeAlias.test(trimmed)) {
    const m = /type\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    return { band: "def", score: WEIGHTS.def, len, privateName: m ? m[1] : null, trimmed };
  }
  if (RE.jsDecl.test(trimmed)) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    return { band: "field", score: WEIGHTS.field, len, privateName: m ? m[1] : null, trimmed, isDecl: true };
  }
  if (RE.jsImportExport.test(trimmed)) {
    return { band: "io", score: WEIGHTS.io, len, privateName: null };
  }
  if (RE.jsDecorator.test(trimmed)) {
    return { band: "decorator", score: WEIGHTS.decorator, len, privateName: null };
  }
  if (RE.jsAccessModifier.test(trimmed)) {
    const m = /^(?:public|private|protected|static|readonly|abstract)\s+(?:static\s+|readonly\s+|abstract\s+)*([A-Za-z_$][\w$]*)/.exec(trimmed);
    return { band: "method", score: WEIGHTS.method, len, privateName: m ? m[1] : null, trimmed };
  }
  if (RE.jsBareMethod.test(trimmed)) {
    const m = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
    return { band: "methodBare", score: WEIGHTS.methodBare, len, privateName: m ? m[1] : null, trimmed };
  }
  if (RE.closingOnly.test(trimmed)) {
    return { band: "close", score: WEIGHTS.close, len, privateName: null };
  }
  if (RE.jsFieldSig.test(trimmed)) {
    return { band: "field", score: WEIGHTS.field, len, privateName: null };
  }
  return { band: "body", score: WEIGHTS.body, len, privateName: null };
}

function indentPenalty(raw) {
  const units = expandedIndentUnits(raw);
  const levels = Math.floor(units / 2);
  return Math.min(levels * 6, 42);
}

function lengthPenalty(len) {
  if (len <= 120) return 0;
  return Math.min(30, Math.floor((len - 120) / 8));
}

/**
 * Score every line of `lines` for `lang`. Returns an array of per-line records:
 * { band, score, tokens, zeroedDoc, zeroedPrivate, forceKeep }.
 * `zeroedDoc`/`zeroedPrivate` are advisory flags the level-based path uses to
 * hard-exclude lines; the raw budget API ignores them.
 */
function scoreLines(lines, lang) {
  const n = lines.length;
  const out = new Array(n);
  let parenCarry = null; // { band, score, balance, forceable, privateName }
  let commentCarry = null; // { band, score, closeToken }

  for (let i = 0; i < n; i++) {
    const raw = lines[i];

    if (commentCarry) {
      out[i] = {
        band: commentCarry.band,
        score: commentCarry.score,
        tokens: countTokens(raw),
        zeroedDoc: commentCarry.band === "doc" || commentCarry.band === "comment",
        zeroedPrivate: false,
      };
      if (raw.length <= DATA_LINE_CHARS && raw.includes(commentCarry.closeToken)) {
        commentCarry = null;
      }
      continue;
    }

    if (parenCarry && parenCarry.balance > 0) {
      out[i] = {
        band: parenCarry.band,
        score: parenCarry.score,
        tokens: countTokens(raw),
        zeroedDoc: false,
        zeroedPrivate: parenCarry.zeroedPrivate,
      };
      if (raw.length <= DATA_LINE_CHARS) {
        parenCarry.balance += bracketDelta(raw, parenCarry.includeBraces);
      }
      if (parenCarry.balance <= 0) parenCarry = null;
      continue;
    }

    const c = classifyLine(raw, lang);
    const pen = c.band === "body" || c.band === "field" ? indentPenalty(raw) + lengthPenalty(c.len) : indentPenalty(raw);
    const score = Math.max(0, c.score - (c.band === "blank" || c.band === "data" ? 0 : pen));

    const zeroedDoc = c.band === "doc" || c.band === "comment";
    const zeroedPrivate = false; // filled in later by applyLevel() using privateName

    out[i] = { band: c.band, score, tokens: countTokens(raw), zeroedDoc, zeroedPrivate, privateName: c.privateName ?? null, isDecl: c.isDecl === true };

    // start a comment/doc carry if this opener isn't closed on the same line
    if (c.closeToken && !raw.includes(c.closeToken)) {
      commentCarry = { band: c.band, score, closeToken: c.closeToken };
      continue;
    }
    if (c.quoteToken) {
      const occurrences = raw.split(c.quoteToken).length - 1;
      if (occurrences < 2) {
        commentCarry = { band: c.band, score, closeToken: c.quoteToken };
      }
      continue;
    }

    // start a signature-carry if this is a carryable band left unbalanced
    if (CARRY_BANDS.has(c.band)) {
      const includeBraces = c.band === "io";
      const delta = bracketDelta(raw, includeBraces);
      if (delta > 0) {
        parenCarry = { band: c.band, score, balance: delta, includeBraces, zeroedPrivate: false, privateName: c.privateName ?? null };
      }
    }
  }

  return out;
}

/**
 * Apply level semantics on top of raw scores: L2+ zero doc/comment bands, L3
 * additionally zeroes non-exported/underscore-prefixed def/method/field lines.
 * Mutates and returns the same array of records (adds `zeroed`/`forceKeep`).
 */
function applyLevel(records, lines, lang, level) {
  const SIGNATURE_BANDS = new Set(["def", "method", "methodBare", "field", "decorator"]);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let zeroed = false;

    if (level >= 2 && r.zeroedDoc) {
      zeroed = true;
      r.score = r.band === "doc" ? ZEROED_DOC_SCORE : ZEROED_COMMENT_SCORE;
    }

    if (level >= 3 && !zeroed && SIGNATURE_BANDS.has(r.band)) {
      const isPrivate = isPyLang(lang)
        ? isPrivatePyName(r.privateName)
        : r.band === "field" && r.isDecl !== true
          ? false // plain `name: Type;` interface field has no export keyword of its own; keep
          : isPrivateJsLine(lines[i]);
      if (isPrivate) {
        zeroed = true;
        r.score = ZEROED_PRIVATE_SCORE;
      }
    }

    r.zeroed = zeroed;
    r.forceKeep = !zeroed && FORCE_KEEP_BANDS.has(r.band);
  }
  return records;
}

/**
 * Greedy top-score-first (first-fit-decreasing) selection under a token
 * budget. `records[i].zeroed` (if present) hard-excludes a line.
 *
 * `honorForceKeep` controls what "must-keep" (import/export/def headers)
 * means:
 *   - true  (level-based `skeletonize()`): those lines are ALWAYS included,
 *     budget or not — an "API card" must never truncate the exported surface
 *     just because a declarations-heavy file has a lot of it.
 *   - false (the raw `skeletonizeToBudget()` bonus API): they are merely
 *     the highest-priority candidates (already true by score alone: `def`
 *     100 / `io` 92 beat everything else) — they can still be dropped if the
 *     caller's explicit token budget genuinely can't fit them, so an
 *     arbitrary requested budget is actually honored rather than blown past.
 */
function selectByBudget(records, tokenBudget, honorForceKeep) {
  const n = records.length;
  const kept = new Uint8Array(n);
  let used = 0;
  const candidates = [];

  for (let i = 0; i < n; i++) {
    const r = records[i];
    if (r.zeroed || r.band === "blank") continue;
    if (honorForceKeep && r.forceKeep) {
      kept[i] = 1;
      used += r.tokens;
    } else {
      candidates.push(i);
    }
  }

  candidates.sort((a, b) => records[b].score - records[a].score || a - b);

  for (const i of candidates) {
    const t = records[i].tokens;
    if (used + t <= tokenBudget) {
      kept[i] = 1;
      used += t;
    }
  }

  return kept;
}

function renderLine(raw) {
  if (raw.length > DATA_LINE_CHARS) {
    const remaining = raw.length - TRUNCATE_HEAD_CHARS;
    return `${raw.slice(0, TRUNCATE_HEAD_CHARS)} … <${remaining} chars>`;
  }
  return raw;
}

function indentOf(raw) {
  const m = /^[ \t]*/.exec(raw);
  return m ? m[0] : "";
}

function render(lines, kept, lang) {
  const n = lines.length;
  const marker = commentTokenFor(lang);
  const out = [];
  let i = 0;
  while (i < n) {
    if (kept[i]) {
      out.push(renderLine(lines[i]));
      i++;
      continue;
    }
    let j = i;
    while (j < n && !kept[j]) j++;
    const gapLen = j - i;
    const indent = j < n ? indentOf(lines[j]) : i > 0 ? indentOf(lines[i - 1]) : "";
    out.push(`${indent}${marker} ⋯ (${gapLen} line${gapLen === 1 ? "" : "s"})`);
    i = j;
  }
  return out.join("\n");
}

/**
 * Same token accounting `render()` produces, without building the final
 * string — used by trimToBudget()'s iterative correction below so repeated
 * "am I under budget yet" checks stay cheap.
 */
function computeOutputTokens(lines, kept, lang) {
  const n = lines.length;
  const marker = commentTokenFor(lang);
  let total = 0;
  let i = 0;
  while (i < n) {
    if (kept[i]) {
      total += countTokens(renderLine(lines[i]));
      i++;
      continue;
    }
    let j = i;
    while (j < n && !kept[j]) j++;
    const gapLen = j - i;
    const indent = j < n ? indentOf(lines[j]) : i > 0 ? indentOf(lines[i - 1]) : "";
    total += countTokens(`${indent}${marker} ⋯ (${gapLen} line${gapLen === 1 ? "" : "s"})`);
    i = j;
  }
  return total;
}

/**
 * selectByBudget() bounds its fill using each kept line's OWN token cost, but
 * the rendered output also spends tokens on elision markers — on a file with
 * many short, scattered keeps (lots of small gaps) that overhead is not
 * negligible and can carry the actual output well past the requested budget.
 * This does a bounded, cheap correction pass: drop the currently-kept,
 * non-must-keep lines in ascending score order (least structurally valuable
 * first) until the REAL rendered token count is back at or under budget, or
 * there is nothing left it is allowed to drop.
 */
function trimToBudget(lines, records, kept, tokenBudget, lang, honorForceKeep) {
  let total = computeOutputTokens(lines, kept, lang);
  if (total <= tokenBudget) return kept;

  const removable = [];
  for (let i = 0; i < records.length; i++) {
    if (!kept[i]) continue;
    if (honorForceKeep && records[i].forceKeep) continue;
    removable.push(i);
  }
  removable.sort((a, b) => records[a].score - records[b].score || b - a);

  // Safety rail: bound the number of expensive O(n) recompute passes rather
  // than looping once per removable line on a huge file — best-effort beyond
  // the cap, never a hang.
  const MAX_TRIM_PASSES = 4000;
  let passes = 0;
  for (const i of removable) {
    if (total <= tokenBudget || passes >= MAX_TRIM_PASSES) break;
    kept[i] = 0;
    total = computeOutputTokens(lines, kept, lang);
    passes++;
  }
  return kept;
}

function splitLines(source) {
  if (source === "") return [""];
  return source.split(/\r\n|\r|\n/);
}

function fallbackExcerpt(source, lang) {
  const marker = commentTokenFor(lang);
  const s = typeof source === "string" ? source : String(source ?? "");
  if (s.length <= 4000) return s;
  const head = s.slice(0, 3000);
  const tail = s.slice(-500);
  return `${head}\n${marker} ⋯ (fallback excerpt: ${s.length - 3500} chars elided)\n${tail}`;
}

/**
 * Core: score -> (optional level zeroing) -> budget-select -> render.
 */
function run({ source, lang, level, tokenBudget, honorForceKeep }) {
  const lines = splitLines(source);
  const records = scoreLines(lines, lang);
  if (typeof level === "number") {
    applyLevel(records, lines, lang, level);
  } else {
    // raw budget API: no level, so no zeroing — but still tag the band so
    // selectByBudget can prioritize it (honorForceKeep decides if it's
    // unconditional or just top-priority).
    for (const r of records) r.forceKeep = FORCE_KEEP_BANDS.has(r.band);
  }
  const kept = selectByBudget(records, tokenBudget, honorForceKeep);
  trimToBudget(lines, records, kept, tokenBudget, lang, honorForceKeep);
  return render(lines, kept, lang);
}

function skeletonizeCore(input) {
  const { source, lang, level } = input;
  const sourceTokens = countTokens(source);
  const pct = BUDGET_PRESET[level] ?? BUDGET_PRESET[1];
  const tokenBudget = Math.max(1, Math.ceil(sourceTokens * pct));
  return run({ source, lang, level, tokenBudget, honorForceKeep: true });
}

function skeletonizeToBudgetCore(input) {
  const { source, lang, tokenBudget } = input;
  const budget = Math.max(1, Math.floor(tokenBudget ?? countTokens(source) * 0.25));
  return run({ source, lang, level: undefined, tokenBudget: budget, honorForceKeep: false });
}

const candidate = {
  id: "topline",
  label: "Topline (dep-free line scorer)",
  languages: LANGS,
  levels: LEVELS,

  skeletonize(input) {
    try {
      const lang = input && input.lang;
      const source = input && typeof input.source === "string" ? input.source : "";
      const level = LEVELS.includes(input && input.level) ? input.level : 1;
      if (!source) return { skeleton: "" };
      return { skeleton: skeletonizeCore({ source, lang, level }) };
    } catch {
      try {
        return { skeleton: fallbackExcerpt(input && input.source, input && input.lang) };
      } catch {
        return { skeleton: "" };
      }
    }
  },
};

/**
 * BONUS dial: keep the top-scored lines until `tokenBudget` (default 25% of
 * source tokens) is filled, ranked by the same scorer `skeletonize()` uses,
 * with no level-based zeroing (there is no level here). Never throws.
 */
export function skeletonizeToBudget(input) {
  try {
    const lang = input && input.lang;
    const source = input && typeof input.source === "string" ? input.source : "";
    if (!source) return { skeleton: "" };
    return { skeleton: skeletonizeToBudgetCore({ source, lang, tokenBudget: input && input.tokenBudget }) };
  } catch {
    try {
      return { skeleton: fallbackExcerpt(input && input.source, input && input.lang) };
    } catch {
      return { skeleton: "" };
    }
  }
}

export default candidate;

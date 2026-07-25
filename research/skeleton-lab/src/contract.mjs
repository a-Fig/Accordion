/*
 * research/skeleton-lab — shared candidate contract.
 *
 * A CANDIDATE is one deterministic strategy for turning a source file into a
 * "skeleton": a drastically smaller stand-in that preserves the structural,
 * load-bearing facts (imports/exports, types, class/function signatures,
 * docstrings) while eliding implementation bodies.
 *
 * Each module in src/candidates/ default-exports an object:
 *
 * {
 *   id: string,          // short slug, e.g. "ast-exact"
 *   label: string,       // human name for report tables
 *   languages: string[], // subset of LANGS it supports
 *   levels: number[],    // aggressiveness levels it implements (subset of [1,2,3])
 *   init?(): Promise<void> | void,   // one-time setup (load wasm, spawn helper…)
 *   skeletonize(input: {
 *     path: string,      // repo-relative or corpus-relative path (for ext/lang hints)
 *     source: string,    // full file text
 *     lang: string,      // one of LANGS, derived from extension by the harness
 *     level: number,     // requested aggressiveness level
 *   }): { skeleton: string } | Promise<{ skeleton: string }>
 * }
 *
 * HARD REQUIREMENTS
 *  - Deterministic: same input → byte-identical skeleton. No Date, no random,
 *    no environment-dependent output (absolute paths, versions) inside the text.
 *  - Total: must return for ANY input (truncated, minified, binary-ish). Throwing
 *    is scored as a hard failure by the harness, not caught silently.
 *  - Standalone text: the skeleton must make sense to an LLM reader with no other
 *    tooling — elisions should be visibly marked (e.g. "…" markers / stub bodies).
 *
 * LEVELS (the aggressiveness dial — the research output is the fidelity-vs-ratio
 * curve across these):
 *  - L1 "interface view": imports/exports, type decls, class/function/method
 *    signatures, docstrings & leading doc comments. Bodies elided.
 *  - L2 "signatures only": L1 minus comments/docstrings.
 *  - L3 "API card": public/exported surface only, maximally compact (one line per
 *    symbol, imports collapsed to a module list, private members dropped or counted).
 */

export const LANGS = ["ts", "tsx", "js", "py"];

/** Map a file path to a harness lang, or null if out of scope. */
export function langOf(path) {
  const m = /\.([a-z]+)$/i.exec(path);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "ts" || ext === "mts" || ext === "cts") return "ts";
  if (ext === "tsx") return "tsx";
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "jsx") return "js";
  if (ext === "py" || ext === "pyi") return "py";
  return null;
}

export const LEVELS = [1, 2, 3];

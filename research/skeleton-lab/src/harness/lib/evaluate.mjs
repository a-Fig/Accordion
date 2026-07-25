/*
 * Shared per-(candidate, corpus entry, level) evaluation, used by both
 * run.mjs (the full matrix) and gallery.mjs (the hardcoded smell-check
 * subset) so the two never compute metrics differently.
 */

import { reduction, signatureRecall, validity, validityLenient } from "../metrics.mjs";

/**
 * Runs skeletonize() twice (determinism check), times only the first call,
 * and computes every metric. Never throws — a candidate throw, or a
 * malformed return value, comes back as { failed: true, error }.
 *
 * The returned object always carries `skeleton` (the first call's text) for
 * gallery.mjs's use; run.mjs deliberately drops that field before writing
 * results.json, whose row schema has no room for full skeleton text.
 */
export async function evaluateOne({ candidate, entry, level, source, symbols }) {
  const base = {
    candidate: candidate.id,
    file: entry.file,
    lang: entry.lang,
    category: entry.category,
    level,
  };

  const input = { path: entry.file, source, lang: entry.lang, level };

  let first;
  let second;
  let ms;
  try {
    const t0 = process.hrtime.bigint();
    first = await candidate.skeletonize(input);
    const t1 = process.hrtime.bigint();
    ms = Number(t1 - t0) / 1e6;
    second = await candidate.skeletonize(input);
  } catch (err) {
    return { ...base, failed: true, error: err?.message ?? String(err) };
  }

  const skel1 = first?.skeleton;
  const skel2 = second?.skeleton;
  if (typeof skel1 !== "string") {
    return { ...base, failed: true, error: "skeletonize() did not return { skeleton: string }" };
  }

  const deterministic = typeof skel2 === "string" && skel2 === skel1;
  const { srcTokens, skelTokens, removedPct } = reduction(source, skel1);
  const recall = signatureRecall(skel1, symbols);
  const v = validity(skel1, entry.lang);
  const vLenient = validityLenient(skel1, entry.lang);

  return {
    ...base,
    srcTokens,
    skelTokens,
    removedPct,
    recallAll: recall.all.fraction,
    recallExported: recall.exported.fraction,
    missing: recall.missing,
    valid: v.valid,
    errorCount: v.errorCount,
    validLenient: vLenient.valid,
    deterministic,
    ms,
    skeleton: skel1,
  };
}

/* Small aggregation/formatting helpers shared by run.mjs's stdout summary
 * and gallery.mjs's one-line stats. Pure, no I/O. */

export function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

export function mean(nums) {
  const clean = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

export function max(nums) {
  const clean = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (clean.length === 0) return null;
  return Math.max(...clean);
}

/** Percent of truthy values in `bools`, or null if empty. */
export function pctTrue(bools) {
  if (bools.length === 0) return null;
  return (bools.filter(Boolean).length / bools.length) * 100;
}

export function fmt(n, digits = 1) {
  return n == null ? "—" : n.toFixed(digits);
}

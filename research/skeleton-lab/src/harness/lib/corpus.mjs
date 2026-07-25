/*
 * Corpus loading: corpus/manifest.json (array of { file, lang, category,
 * origin, note }) and corpus/groundtruth.json ({ "<file>": { symbols: [...] } }).
 * Both are tolerated as absent/empty — the harness must run cleanly before
 * the corpus exists.
 *
 * Convention: manifest entries observed in this lab store `file` already
 * rooted at the lab (skeleton-lab/) root, e.g. "corpus/files/types.ts" — so
 * source resolution is rootDir-relative, with a corpus-dir-relative fallback
 * in case that convention ever changes.
 */

import { readFile, access } from "node:fs/promises";
import path from "node:path";

export async function loadManifest(corpusDir) {
  try {
    const text = await readFile(path.join(corpusDir, "manifest.json"), "utf8");
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function loadGroundtruth(corpusDir) {
  try {
    const text = await readFile(path.join(corpusDir, "groundtruth.json"), "utf8");
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a manifest entry's `file` to an absolute path, rootDir-relative first. */
export async function resolveSourcePath(rootDir, entry) {
  const rootRelative = path.resolve(rootDir, entry.file);
  if (await exists(rootRelative)) return rootRelative;
  const corpusRelative = path.resolve(rootDir, "corpus", entry.file);
  if (await exists(corpusRelative)) return corpusRelative;
  return rootRelative; // neither exists; surface this path in the resulting ENOENT
}

export async function readSource(rootDir, entry) {
  const full = await resolveSourcePath(rootDir, entry);
  return readFile(full, "utf8");
}

export function symbolsFor(groundtruth, entry) {
  return groundtruth?.[entry.file]?.symbols ?? [];
}

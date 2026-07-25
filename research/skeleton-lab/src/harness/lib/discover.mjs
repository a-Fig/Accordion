/*
 * Candidate discovery: every .mjs file directly in src/candidates/ is
 * expected to default-export a contract object ({ id, label, languages,
 * levels, init?, skeletonize }) per src/contract.mjs. Non-.mjs files (e.g. a
 * .py helper a candidate shells out to) are ignored. A candidate module that
 * fails to import, or whose default export doesn't look like a contract, is
 * recorded as broken rather than crashing the harness.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function looksLikeContract(mod) {
  return (
    mod &&
    typeof mod === "object" &&
    typeof mod.id === "string" &&
    typeof mod.skeletonize === "function"
  );
}

/**
 * @param {string} candidatesDir absolute path to src/candidates
 * @returns {Promise<{ candidates: {file:string, contract:object}[], broken: {id:string, file:string, stage:"import", error:string}[] }>}
 */
export async function discoverCandidates(candidatesDir) {
  const candidates = [];
  const broken = [];

  let entries;
  try {
    entries = await readdir(candidatesDir, { withFileTypes: true });
  } catch {
    // No candidates directory yet — nothing to discover, not an error.
    return { candidates, broken };
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mjs"))
    .map((e) => e.name)
    .sort();

  for (const file of files) {
    const full = path.join(candidatesDir, file);
    try {
      const mod = await import(pathToFileURL(full).href);
      const contract = mod?.default;
      if (!looksLikeContract(contract)) {
        broken.push({
          id: contract?.id ?? file,
          file,
          stage: "import",
          error: "default export is missing the required { id, skeletonize } shape",
        });
        continue;
      }
      candidates.push({ file, contract });
    } catch (err) {
      broken.push({ id: file, file, stage: "import", error: err?.message ?? String(err) });
    }
  }

  return { candidates, broken };
}

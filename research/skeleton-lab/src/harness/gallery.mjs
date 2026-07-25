#!/usr/bin/env node
/*
 * Smell-check artifacts: for a hardcoded representative subset of the
 * corpus (~4 typical files spread across langs + the first 2 adversarial
 * files, selected by manifest order/category so it works with any
 * manifest), run every discovered candidate × every level it supports and
 * write out the full skeleton text for human eyeballing.
 *
 * Writes:
 *   results/gallery/<basename>__<candidate>__L<n>.md
 *   results/gallery/INDEX.md   (links + one-line stats)
 *
 * Runs cleanly to "nothing to do" with zero candidates and/or zero corpus.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEVELS } from "../contract.mjs";
import { discoverCandidates } from "./lib/discover.mjs";
import { loadManifest, loadGroundtruth, readSource, symbolsFor } from "./lib/corpus.mjs";
import { evaluateOne } from "./lib/evaluate.mjs";
import { fmt } from "./lib/format.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const CANDIDATES_DIR = path.join(ROOT, "src", "candidates");
const CORPUS_DIR = path.join(ROOT, "corpus");
const GALLERY_DIR = path.join(ROOT, "results", "gallery");

const FENCE_LANG = { ts: "typescript", tsx: "tsx", js: "javascript", py: "python" };

/** ~4 typical files spread across distinct langs (manifest order), then the
 * first 2 adversarial files. Works with any manifest, including an empty one. */
function pickSubset(manifest) {
  const typical = manifest.filter((e) => e.category === "typical");
  const adversarial = manifest.filter((e) => e.category === "adversarial");

  const picked = [];
  const seenLangs = new Set();
  for (const e of typical) {
    if (picked.length >= 4) break;
    if (seenLangs.has(e.lang)) continue;
    seenLangs.add(e.lang);
    picked.push(e);
  }
  if (picked.length < 4) {
    for (const e of typical) {
      if (picked.length >= 4) break;
      if (!picked.includes(e)) picked.push(e);
    }
  }

  return { typical: picked, adversarial: adversarial.slice(0, 2) };
}

function safeBasename(file) {
  return path.basename(file).replace(/[^\w.-]/g, "_");
}

/** A fenced code block that can't be broken by backticks already present in `text`. */
function fence(text, lang) {
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((m, s) => Math.max(m, s.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang ?? ""}\n${text}\n${ticks}`;
}

function statLine(full) {
  if (full.failed) {
    return `candidate=${full.candidate} level=${full.level} lang=${full.lang} category=${full.category} FAILED error=${full.error}`;
  }
  return (
    `candidate=${full.candidate} level=${full.level} lang=${full.lang} category=${full.category} ` +
    `srcTokens=${full.srcTokens} skelTokens=${full.skelTokens} removedPct=${fmt(full.removedPct)} ` +
    `recallAll=${fmt(full.recallAll, 2)} recallExported=${fmt(full.recallExported, 2)} ` +
    `valid=${full.valid} validLenient=${full.validLenient} deterministic=${full.deterministic} ms=${fmt(full.ms, 2)}`
  );
}

async function main() {
  const [{ candidates, broken }, manifest, groundtruth] = await Promise.all([
    discoverCandidates(CANDIDATES_DIR),
    loadManifest(CORPUS_DIR),
    loadGroundtruth(CORPUS_DIR),
  ]);

  const { typical, adversarial } = pickSubset(manifest);
  const selected = [...typical, ...adversarial];

  await mkdir(GALLERY_DIR, { recursive: true });

  const indexLines = ["# Gallery index", ""];

  if (candidates.length === 0 || selected.length === 0) {
    indexLines.push(
      `Nothing to do — ${candidates.length === 0 ? "no candidates discovered" : "no corpus files selected"} ` +
        `(candidates: ${candidates.length}, manifest entries selected: ${selected.length}).`,
    );
    if (broken.length > 0) {
      indexLines.push("", "Broken candidates:");
      for (const b of broken) indexLines.push(`- ${b.id}: ${b.error}`);
    }
    await writeFile(path.join(GALLERY_DIR, "INDEX.md"), `${indexLines.join("\n")}\n`, "utf8");
    console.log(indexLines.join("\n"));
    return;
  }

  if (broken.length > 0) {
    indexLines.push("Broken candidates (excluded):");
    for (const b of broken) indexLines.push(`- ${b.id}: ${b.error}`);
    indexLines.push("");
  }

  for (const entry of selected) {
    let source;
    try {
      source = await readSource(ROOT, entry);
    } catch (err) {
      indexLines.push(`- ${entry.file}: source file not found (${err?.message ?? String(err)})`);
      continue;
    }
    const symbols = symbolsFor(groundtruth, entry);
    const base = safeBasename(entry.file);

    indexLines.push(`## ${entry.file} (${entry.category})`, "");

    for (const { contract } of candidates) {
      if (!contract.languages?.includes(entry.lang)) continue;
      try {
        if (typeof contract.init === "function") await contract.init();
      } catch (err) {
        indexLines.push(`- ${contract.id}: init() failed — ${err?.message ?? String(err)}`);
        continue;
      }

      const levels = (contract.levels ?? []).filter((l) => LEVELS.includes(l));
      for (const level of levels) {
        const full = await evaluateOne({ candidate: contract, entry, level, source, symbols });
        const outName = `${base}__${contract.id}__L${level}.md`;
        const body = full.failed
          ? `${statLine(full)}\n`
          : `${statLine(full)}\n\n${fence(full.skeleton, FENCE_LANG[entry.lang] ?? "")}\n`;
        await writeFile(path.join(GALLERY_DIR, outName), `# ${entry.file} — ${contract.label} (L${level})\n\n${body}`, "utf8");
        indexLines.push(`- [${outName}](${outName}) — ${statLine(full)}`);
      }
    }
    indexLines.push("");
  }

  await writeFile(path.join(GALLERY_DIR, "INDEX.md"), `${indexLines.join("\n")}\n`, "utf8");
  console.log(indexLines.join("\n"));
}

main().catch((err) => {
  console.error("gallery.mjs crashed:", err);
  process.exitCode = 1;
});

/**
 * scorer.mjs — thin wrapper that reuses the attention-folder probe for Thermocline.
 *
 * This module does NOT copy or reimplement probe spawning logic. It re-exports
 * `scoreCandidates` (and helpers) directly from `conductors/attention-folder/scorer.mjs`,
 * which resolves the shared probe (`conductors/attention-folder/probe/probe.py`) via an
 * absolute path anchored to attention-folder's own `__dirname`. The probe path is therefore
 * always correct regardless of the cwd from which the thermocline server is started.
 *
 * Contract (same as attention-folder):
 *   scoreCandidates({ tailText, candidates, signal }) → Promise<Map<string, number>>
 *     tailText   — string representing the current work tail (newest protected blocks)
 *     candidates — Array<{ id: string, text: string }> blocks to score
 *     signal     — optional AbortSignal (drops the probe and rejects if aborted)
 *   Returns a Map<blockId, score> where higher score = more relevant = keep live longer.
 *
 * Also re-exports `tailTextFromView` and `resolvePython` from the same
 * source so thermocline's server code has one consistent import surface.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the absolute path to attention-folder/scorer.mjs so this import is
// cwd-independent and survives being invoked from any working directory.
const ATTN_SCORER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"attention-folder",
	"scorer.mjs",
);

// Dynamic import lets us keep the path as a computed string (static import paths
// must be literals). In practice this resolves once at module load time.
const {
	scoreCandidates,
	tailTextFromView,
	resolvePython,
} = await import(ATTN_SCORER);

export { scoreCandidates, tailTextFromView, resolvePython };

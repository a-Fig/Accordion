// scorer.mjs — async bridge to the Python attention probe (probe/probe.py).
//
// The probe is a ~6s-load + ~0.15s/window GPU job (~8–18s for a full session). It MUST NOT
// run inside the WebSocket message handler — that would stall the conductor's `hold`/`epoch`
// replies. So this spawns the probe as a child process (async `spawn`, never `spawnSync`)
// and resolves a Map<blockId, score> when it finishes. The server fires this off in the
// background between epochs and folds against whatever scores are ready (the policy degrades
// gracefully when they lag).
//
// Higher score = more attention/relevance to the current work tail = keep live longer.
// The policy folds the LOWEST scores first.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Char caps to keep the spawn payload small; the probe re-truncates by TOKENS internally.
const TAIL_CHAR_CAP = 12_000;
const BLOCK_CHAR_CAP = 3_000;

/**
 * Resolve the probe's Python interpreter. Order:
 *   1. $ATTN_PROBE_PYTHON (explicit override),
 *   2. a local venv at probe/.venv/Scripts/python.exe (Windows) or probe/.venv/bin/python,
 *   3. bare "python" on PATH.
 */
export function resolvePython() {
	if (process.env.ATTN_PROBE_PYTHON) return process.env.ATTN_PROBE_PYTHON;
	const win = join(HERE, "probe", ".venv", "Scripts", "python.exe");
	const nix = join(HERE, "probe", ".venv", "bin", "python");
	for (const p of [win, nix]) {
		if (existsSync(p)) return p;
	}
	return "python";
}

const PROBE_SCRIPT = process.env.ATTN_PROBE_SCRIPT || join(HERE, "probe", "probe.py");

function capHeadTail(text, cap) {
	if (!text) return "";
	if (text.length <= cap) return text;
	const head = Math.floor(cap * 0.75);
	return text.slice(0, head) + " … " + text.slice(text.length - (cap - head));
}

function capTailNewest(text, cap) {
	if (!text) return "";
	return text.length <= cap ? text : text.slice(text.length - cap);
}

/**
 * Score `candidates` (each {id, text}) by attention relevance to `tailText`.
 *
 * @returns {Promise<Map<string,number>>} resolves to id→score; rejects on spawn/exit error.
 */
export function scoreCandidates({ tailText, candidates, python = resolvePython(), script = PROBE_SCRIPT, batch = 24, attnImpl = "sdpa", timeoutMs = 180_000, signal, log = () => {} }) {
	return new Promise((resolvePromise, reject) => {
		if (!candidates.length) {
			resolvePromise(new Map());
			return;
		}
		// External abort (the WebSocket connection dropped): don't even start.
		if (signal?.aborted) {
			reject(new Error("probe aborted before start"));
			return;
		}

		const payload = {
			tail: capTailNewest(tailText || "", TAIL_CHAR_CAP),
			blocks: candidates.map((c) => ({ id: c.id, text: capHeadTail(c.text || "", BLOCK_CHAR_CAP) })),
		};

		// Create the temp dir, then guard EVERY setup step. A throw before the settle machinery
		// is wired below (writeFile ENOSPC/EACCES, a synchronous spawn failure) would otherwise
		// reject the promise while leaking the dir on disk — one per failed scoring epoch.
		const dir = mkdtempSync(join(tmpdir(), "attn-cond-"));
		const inPath = join(dir, "in.json");
		const outPath = join(dir, "out.json");
		let proc;
		try {
			writeFileSync(inPath, JSON.stringify(payload), "utf8");
			const args = [script, "--in", inPath, "--out", outPath, "--batch", String(batch), "--attn-impl", attnImpl];
			proc = spawn(python, args, { stdio: ["ignore", "ignore", "pipe"] });
		} catch (e) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
			reject(new Error(`probe setup failed: ${e.message}`));
			return;
		}
		const t0 = Date.now();

		let stderr = "";
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});

		// Single-settle guard + watchdog + external abort. A hung probe (driver wedge, download
		// stall) would otherwise emit neither close nor error and the promise would never settle —
		// which, in the conductor, would leave scoringInFlight stuck true and silently disable all
		// future scoring. The timeout (or an abort from a dropped connection) kills the child and
		// rejects so the caller can recover and the GPU isn't held by an abandoned job.
		const kill = () => {
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		let settled = false;
		const done = (fn, arg) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
			fn(arg);
		};
		const timer = setTimeout(() => {
			kill();
			done(reject, new Error(`probe timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onAbort = () => {
			kill();
			done(reject, new Error("probe aborted (connection closed)"));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		proc.on("error", (err) => done(reject, new Error(`probe spawn failed: ${err.message}`)));

		proc.on("close", (code) => {
			if (code !== 0) {
				done(reject, new Error(`probe exited ${code}: ${stderr.trim().split("\n").slice(-1)[0] || ""}`));
				return;
			}
			let result;
			try {
				result = JSON.parse(readFileSync(outPath, "utf8"));
			} catch (e) {
				done(reject, new Error(`probe output unreadable: ${e.message}`));
				return;
			}
			const scores = new Map();
			for (const [id, v] of Object.entries(result.scores || {})) {
				if (typeof v === "number" && Number.isFinite(v)) scores.set(id, v);
			}
			const meta = result.meta || {};
			log(`scored ${scores.size} blocks in ${Date.now() - t0}ms (probe ${meta.wallMs}ms, ${meta.device})`);
			done(resolvePromise, scores);
		});
	});
}

/** Build the probe's "tail" (current work) text from the protected-tail blocks, newest-first
 *  walking, capped — mirrors the lab's tail construction. */
export function tailTextFromView(blocks) {
	let text = "";
	for (let i = blocks.length - 1; i >= 0 && text.length < TAIL_CHAR_CAP; i--) {
		const b = blocks[i];
		if (!b.protected) break;
		if (b.text !== undefined) text = b.text + "\n" + text;
	}
	return text;
}

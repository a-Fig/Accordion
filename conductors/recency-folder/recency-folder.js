// recency-folder.js — a runnable reference conductor for Accordion (ADR 0007).
//
// Hosts a WebSocket server, advertises itself for auto-discovery under
// ~/.accordion/conductors/, and on each `context/update` folds the oldest non-protected
// `tool_result` blocks until the live estimate is under budget — the spirit of the
// built-in (oldest-first, results decay fastest).
//
// Intentionally simple: it estimates each fold's saving as the whole block (the host
// clamps + re-counts the digest residue exactly) and ignores `host/commandResult` +
// `host/event`. A real conductor reads the clamp reports, respects `human-override`, and
// may use the `countTokens` capability for exact accounting. But it is correct against the
// real message shapes — Accordion will attach, fold tiles, and report back.
//
// Run:  npm install   then   npm start   (or: node recency-folder.js)
// Full protocol reference: ../../docs/conductor-protocol.md
import { WebSocketServer } from "ws";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ID = "recency-folder";
const LABEL = "Recency folder";
const PORT = 7700;
const URL = `ws://127.0.0.1:${PORT}`;

// ── Auto-discovery: advertise a heartbeat file under ~/.accordion/conductors/ ──
// Accordion's desktop discovery polls this directory; an entry older than 15 s is reaped.
// Base honors ACCORDION_HOME (falling back to homedir) — this MUST mirror the Rust
// registry_root() resolver (app/src-tauri/src/lib.rs) so discovery agrees on the directory.
const REG_DIR = join(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");
const REG_FILE = join(REG_DIR, `${ID}.json`);
const startedAt = Date.now();

function advertise() {
	mkdirSync(REG_DIR, { recursive: true });
	const entry = {
		registryProtocol: 1,
		conductorProtocol: 3,
		id: ID,
		label: LABEL,
		url: URL,
		pid: process.pid,
		startedAt,
		heartbeatAt: Date.now(),
	};
	// Atomic write (temp + rename) so Accordion never reads a half-written descriptor.
	const tmp = `${REG_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry, null, 2));
	renameSync(tmp, REG_FILE);
}
advertise();
const heartbeat = setInterval(advertise, 5_000); // well under the 15 s stale window

function shutdown() {
	clearInterval(heartbeat);
	try {
		rmSync(REG_FILE, { force: true }); // stop advertising on exit
	} catch {
		/* already gone */
	}
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── The conductor itself ──
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("connection", (ws) => {
	// Declare intent: we want each block's full text (the default fidelity).
	ws.send(
		JSON.stringify({
			type: "conductor/hello",
			conductorProtocol: 3,
			id: ID,
			label: LABEL,
			wants: { content: "full" },
		}),
	);

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (msg.type !== "context/update") return; // ignore hello/commandResult/event for this demo

		// Fold oldest, non-protected, not-yet-folded tool_results until under budget.
		// Use the host-supplied liveTokens as the baseline (already accounts for human
		// folds, folded-group carriers, and digest residue — far more accurate than
		// recomputing from b.tokens). Each fold saves (b.tokens - b.foldedTokens).
		let live = msg.liveTokens;
		const ids = [];
		for (const b of msg.blocks) {
			// blocks arrive in conversation order (oldest first)
			if (live <= msg.budget) break;
			if (b.kind !== "tool_result" || b.folded || b.protected) continue;
			ids.push(b.id);
			live -= (b.tokens - b.foldedTokens); // host clamps + re-counts exactly
		}

		// A conductor always replies with its COMPLETE desired state, echoing the rev.
		ws.send(
			JSON.stringify({
				type: "conductor/commands",
				rev: msg.rev,
				commands: ids.length ? [{ kind: "fold", ids }] : [],
			}),
		);
	});
});

console.log(`${LABEL} listening on ${URL}\nadvertised at ${REG_FILE}`);

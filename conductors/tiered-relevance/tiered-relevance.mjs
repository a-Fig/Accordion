// tiered-relevance.mjs — a relevance-driven, level-of-detail context conductor for Accordion.
//
// The idea (see README.md): every block continuously sits at the fidelity TIER its relevance
// earns — Full → Trim → Digest → Group — and the budget decides how generous the tiers are.
// Relevance is unified: r(block) = max(cos(block, goal), cos(block, trajectory)), where goal =
// prompt + maintained task summary and trajectory = the working tail. Fold, unfold, and
// anti-thrash all fall out of one re-tiering computation inside a [60%, 90%] hysteresis band.
//
// Topology mirrors attention-folder/recency-folder: this process HOSTS a WebSocket server,
// advertises under ~/.accordion/conductors/ for desktop auto-discovery, and Accordion dials in.
//
// Run:  npm install   then   npm start
//       Embeddings default to Ollama embeddinggemma; summaries use local Ollama,
//       then Gemini/Anthropic if configured. Missing providers degrade gracefully (keyword
//       relevance / deterministic digests) — the conductor still runs.

import { WebSocketServer } from "ws";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.local (git-ignored) so secrets like GEMINI_API_KEY stay OUT of tracked files.
// Real env vars always win (we never overwrite an already-set key).
(function loadEnvLocal() {
	try {
		const f = join(dirname(fileURLToPath(import.meta.url)), ".env.local");
		if (!existsSync(f)) return;
		for (const line of readFileSync(f, "utf8").split("\n")) {
			const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
			if (!m) continue;
			let val = m[2];
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
			if (!(m[1] in process.env)) process.env[m[1]] = val;
		}
	} catch { /* ignore */ }
})();

import { computeTiers, tierSignature, DEFAULT_CFG } from "./tiers.mjs";
import { buildCommands, snapshotState } from "./commands.mjs";
import { RelevanceEngine, createEmbeddingProvider, EMBEDDING_MODEL } from "./relevance.mjs";
import { Summarizer, detectChatProvider } from "./summaries.mjs";
import { deterministicDigest } from "./digest.mjs";
import { buildFoldUnits } from "./units.mjs";

// Mirrors CONDUCTOR_PROTOCOL_VERSION in conductors/contract/protocol.ts. Inlined as a literal
// (not imported) so the conductor runs under plain `node` on any version: importing the .ts
// contract requires TypeScript type-stripping, unflagged only since Node 22.18 / 23.6 — on
// older Node an import of a .ts file throws ERR_UNKNOWN_FILE_EXTENSION at load. The peer
// conductors (recency-folder, attention-folder) inline it the same way. Keep in lockstep with
// the contract on any protocol bump.
const CONDUCTOR_PROTOCOL_VERSION = 3;

const ID = "tiered-relevance";
const LABEL = "Tiered relevance";
const PORT = Number(process.env.TIERS_PORT || 7702); // recency=7700, attention=7701
const URL = `ws://127.0.0.1:${PORT}`;

const CFG = {
	...DEFAULT_CFG,
	highWater: Number(process.env.TIERS_HIGH_WATER || DEFAULT_CFG.highWater),
	lowWater: Number(process.env.TIERS_LOW_WATER || DEFAULT_CFG.lowWater),
	floatFloor: Number(process.env.TIERS_FLOAT_FLOOR || DEFAULT_CFG.floatFloor),
	floatMargin: Number(process.env.TIERS_FLOAT_MARGIN || DEFAULT_CFG.floatMargin),
};

function log(msg) {
	process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Auto-discovery heartbeat (mirrors Rust registry_root in app/src-tauri/src/lib.rs) ──
const REG_DIR = join(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");
const REG_FILE = join(REG_DIR, `${ID}.json`);
const startedAt = Date.now();

function advertise() {
	mkdirSync(REG_DIR, { recursive: true });
	const entry = {
		registryProtocol: 1, conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
		id: ID, label: LABEL, url: URL,
		pid: process.pid, startedAt, heartbeatAt: Date.now(),
	};
	const tmp = `${REG_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry, null, 2));
	renameSync(tmp, REG_FILE);
}
advertise();
const heartbeat = setInterval(advertise, 5_000);

function shutdown() {
	clearInterval(heartbeat);
	try { rmSync(REG_FILE, { force: true }); } catch { /* gone */ }
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Lazy, process-wide model setup (shared across connections) ──
let embeddingProviderPromise = null;
function embeddingProvider() {
	embeddingProviderPromise ??= createEmbeddingProvider()
		.then((p) => { log(`embeddings: provider loaded — ${EMBEDDING_MODEL} (weights download/load on first warm; relevance is keyword until then)`); return p; })
		.catch((e) => { log(`embeddings DISABLED → keyword relevance: ${e.message}`); return null; });
	return embeddingProviderPromise;
}
let chatProviderPromise = null;
function chatProvider() {
	chatProviderPromise ??= detectChatProvider({ log });
	return chatProviderPromise;
}

function freshState() {
	const summarizer = new Summarizer(null, { log });
	const relevance = new RelevanceEngine({ log });
	return {
		relevance,
		summarizer,
		prev: { levels: new Map(), grouped: new Set() }, // our last applied desired state
		lastSentSig: null,
		pendingRev: -1,
		pendingState: null,
		keepLive: new Set(), // agent self-unfolds (M3) — never re-fold
		lastView: null,
		lastPrompt: "",
		warmInFlight: false,
		ready: false,
	};
}

/** Latest user prompt = text of the last user-kind block. */
function latestPrompt(blocks) {
	for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === "user") return blocks[i].text || "";
	return "";
}

/** Compute tiers for the current view, build commands, and send IFF the desired state
 *  changed (keeps the inference prompt prefix stable between real changes). */
function recomputeAndSend(ws, state, rev) {
	if (!state.lastView || ws.readyState !== 1) return;
	const view = state.lastView;
	const result = computeTiers(
		view,
		(b) => state.relevance.relevanceOf(b),
		(b) => state.summarizer.summaryFor(b),
		state.prev,
		{ ...CFG, keepLive: state.keepLive },
	);

	const sig = tierSignature(result, (b) => state.summarizer.summaryFor(b));

	// Schedule LLM digests for everything heading to Digest (off the critical path).
	const grouped = new Set(result.groups.flatMap((g) => g.unitIds));
	const l2Blocks = [];
	for (const u of result.candidates) {
		if (grouped.has(u.id)) { for (const b of u.blocks) l2Blocks.push(b); continue; }
		if (result.levels.get(u.id) === 2) for (const b of u.blocks) l2Blocks.push(b);
	}
	state.summarizer.enqueueBlocks(l2Blocks, deterministicDigest);

	sendStatus(ws, state, result);

	if (sig === state.lastSentSig) return; // no change → hold (host keeps last applied state)

	const commands = buildCommands(result, {
		summaryFor: (b) => state.summarizer.summaryFor(b),
		segmentRelevanceFn: () => state.relevance.segmentRelevanceFn(),
	});
	ws.send(JSON.stringify({ type: "conductor/commands", rev, commands }));
	state.pendingRev = rev;
	state.pendingState = snapshotState(result);
	state.lastSentSig = sig;
	log(`tiers: ${result.action} → ${(result.fullness * 100).toFixed(0)}% (${commands.length} cmds)`);
}

function sendStatus(ws, state, result) {
	if (ws.readyState !== 1) return;
	const pct = Math.round((result.fullness || 0) * 100);
	const grouped = new Set(result.groups.flatMap((g) => g.unitIds));
	const folded = [...result.levels.entries()].filter(([id, l]) => l > 0 || grouped.has(id)).length;
	const rmode = state.relevance.mode; // "keyword" | "loading" | "semantic"
	const relTag = rmode === "keyword" ? "keyword (no embeddings)" : `${rmode} · ${state.relevance.embeddingModel}`;
	const text = `${pct}% · ${result.action} · band ${Math.round(CFG.lowWater * 100)}–${Math.round(CFG.highWater * 100)}% · ${folded} folded · ${relTag}`;
	ws.send(JSON.stringify({
		type: "conductor/status", text,
		metrics: { fullness: pct, action: result.action, folded, relevance: rmode, embeddingModel: state.relevance.embeddingModel },
	}));
}

/** Kick the async warm (embeddings + task summary) for the current view, then re-send. */
function maybeWarm(ws, state) {
	if (state.warmInFlight || !state.lastView) return;
	const view = state.lastView;
	const prompt = latestPrompt(view.blocks);
	state.warmInFlight = true;
	state.relevance.warm(view.blocks, prompt)
		.catch((e) => log(`warm failed: ${e.message}`))
		.finally(() => {
			state.warmInFlight = false;
			state.relevance.prune(view.blocks);
			recomputeAndSend(ws, state, state.lastView?.rev ?? -1);
		});
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("connection", (ws) => {
	const state = freshState();
	// When embeddings first activate, L1 trim excerpts improve from keyword to semantic —
	// null lastSentSig so the post-warm recomputeAndSend re-sends with the better content.
	state.relevance.onSemantic = () => { state.lastSentSig = null; };
	log("Accordion connected");

	// Wire the shared models into this connection's engines (async, non-blocking).
	embeddingProvider().then((p) => { if (p) state.relevance.embed = p; });
	chatProvider().then((p) => {
		const summarizer = new Summarizer(p, {
			log,
			onSummaryReady: () => recomputeAndSend(ws, state, state.lastView?.rev ?? -1),
		});
		state.summarizer = summarizer;
		if (p) state.relevance.summaryProvider = summarizer.taskSummaryProvider();
	});

	ws.send(JSON.stringify({
		type: "conductor/hello", conductorProtocol: CONDUCTOR_PROTOCOL_VERSION, id: ID, label: LABEL,
		wants: { content: "full" },
	}));

	ws.on("message", (raw) => {
		let msg;
		try { msg = JSON.parse(raw.toString()); } catch { return; }

		if (msg.type === "host/event") {
			if (msg.event === "agentUnfold") for (const id of msg.ids || []) state.keepLive.add(id);
			return;
		}

		if (msg.type === "host/commandResult") {
			if (msg.rev === state.pendingRev && state.pendingState) {
				state.prev = state.pendingState;
				// Any clamped command means the host refused part of our desired state (human
				// override / protected / grouped). Drop those units so we stop re-targeting them;
				// the next re-tier self-heals from the view's flags regardless.
				for (const r of msg.reports || []) {
					for (const id of r.ids || []) {
						for (const u of buildFoldUnits(state.lastView?.blocks ?? [])) {
							if (u.blockIds.includes(id)) { state.prev.levels.delete(u.id); state.prev.grouped.delete(u.id); }
						}
					}
				}
				if ((msg.reports || []).length) state.lastSentSig = null; // force a fresh emit next pass
			}
			return;
		}

		if (msg.type !== "context/update") return;

		state.lastView = {
			blocks: msg.blocks,
			budget: msg.budget,
			contextWindow: msg.contextWindow,
			liveTokens: msg.liveTokens,
			protectedFromIndex: msg.protectedFromIndex,
			protectTokens: msg.protectTokens,
			rev: msg.rev,
		};
		const currentIds = new Set(msg.blocks.map((b) => b.id));
		for (const id of state.keepLive) if (!currentIds.has(id)) state.keepLive.delete(id);

		const prompt = latestPrompt(msg.blocks);
		if (prompt !== state.lastPrompt) {
			state.lastPrompt = prompt;
			state.relevance.noteUserPrompt(prompt, msg.blocks);
		}

		// Act now with whatever relevance we have (keyword fallback defends the band before
		// embeddings land); kick the async warm so the next pass is semantic.
		recomputeAndSend(ws, state, msg.rev);
		maybeWarm(ws, state);
	});

	ws.on("close", () => { log("Accordion disconnected"); });
});

log(`${LABEL} listening on ${URL}`);
log(`band ${(CFG.lowWater * 100).toFixed(0)}–${(CFG.highWater * 100).toFixed(0)}%  float floor ${CFG.floatFloor}+${CFG.floatMargin}  advertised at ${REG_FILE}`);
log(`relevance model: ${EMBEDDING_MODEL} (status shows keyword → loading → semantic; watch for "embeddings ACTIVE")`);

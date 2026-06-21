/*
 * the-conductor.ts — a faithful port of the_conductor's context strategy as an Accordion
 * external (WebSocket) conductor.
 *
 * the_conductor was a monolithic pi extension (`runConductor(messages) → rewritten messages`).
 * This conductor keeps its STRATEGY verbatim (`strategy.ts`, vendored from
 * the_conductor/src/conductor.ts) — the self-calibrating fold-target band, graduated
 * Full/Trim/Digest/Group levels, three-stage relevance (keyword → embeddings → cross-encoder
 * rerank), risk-aware unfold floors, and conductor pins — and replaces only its I/O ends:
 *
 *   - INPUT:  Accordion's `ConductorView` (linearized blocks) → `ParsedContext`  (adapter.ts)
 *   - OUTPUT: per-block fold levels → `fold`/`replace`/`group` commands               (commands.ts)
 *
 * Topology mirrors tiered-relevance / attention-folder / recency-folder: this process HOSTS a
 * WebSocket server, advertises under ~/.accordion/conductors/ for desktop auto-discovery, and
 * Accordion dials in. It is COLLABORATIVE (declares no locks): human and agent overrides always
 * win, and the host's protected tail is absolute.
 *
 * Run:  node the-conductor.ts   (Node ≥ 23.6, or ≥ 22.18 with --experimental-strip-types).
 *       Phase 1 ships deterministic-only: keyword relevance + deterministic digests. Embeddings,
 *       cross-encoder rerank, and LLM summaries are wired in later phases via `deps`.
 */
import { WebSocketServer } from "ws";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	createAccordionState,
	computeFoldPlan,
	buildFactLedger,
	buildRelevanceTOC,
	formatTurnRanges,
	warmEmbeddings,
	warmRerank,
	pruneEmbeddingCache,
	createTransformersEmbeddingProvider,
	createTransformersRerankProvider,
	createOllamaSummaryProvider,
	createHaikuSummaryProvider,
	createGeminiSummaryProvider,
	EMBEDDING_MODEL,
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_MODEL,
	type AccordionState,
	type ConductorDependencies,
	type EmbeddingProvider,
	type RerankProvider,
	type SummaryProvider,
} from "./strategy.ts";
import {
	viewToParsed,
	offLimitsIds,
	latestPrompt,
	applyPlanToState,
	type ViewBlock,
} from "./adapter.ts";
import { buildCommands, planSignature } from "./commands.ts";

// Mirrors CONDUCTOR_PROTOCOL_VERSION in conductors/contract/protocol.ts (v3 = locks + complete).
const CONDUCTOR_PROTOCOL_VERSION = 3;

const ID = "the-conductor";
const LABEL = "The Conductor";
const PORT = Number(process.env.CONDUCTOR_PORT || 7703); // recency=7700, attention=7701, tiered=7702
const URL = `ws://127.0.0.1:${PORT}`;

function log(msg: string): void {
	process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Process-wide model providers (shared across connections; lazy + fallback-safe) ──
// Embeddings (bi-encoder) are attempted by default; if @huggingface/transformers is absent the
// provider creation throws and relevance falls back to keyword overlap. The cross-encoder
// reranker (two-stage relevance) is opt-in via ACCORDION_RERANK=1 — it is heavier and only
// rescues the folded shortlist. Both degrade gracefully to the deterministic path.
const RERANK_ENABLED = process.env.ACCORDION_RERANK === "1" || process.env.ACCORDION_RERANK === "true";
const EMBEDDINGS_DISABLED = process.env.ACCORDION_EMBEDDINGS === "0" || process.env.ACCORDION_EMBEDDINGS === "false";

let embeddingProvider: EmbeddingProvider | null = null;
let embeddingInit: Promise<void> | null = null;
let embeddingWarmedOnce = false;
let rerankProvider: RerankProvider | null = null;
let rerankInitAttempted = false;

async function ensureEmbeddingProvider(): Promise<void> {
	if (EMBEDDINGS_DISABLED || embeddingProvider) return;
	embeddingInit ??= (async () => {
		try {
			embeddingProvider = await createTransformersEmbeddingProvider();
			log(`embeddings: ${EMBEDDING_MODEL} loaded (weights load on first warm; keyword until then)`);
		} catch (e: any) {
			embeddingProvider = null;
			embeddingInit = null; // allow a later retry, but stay on keyword for now
			log(`embeddings DISABLED → keyword relevance: ${e?.message ?? e}`);
		}
	})();
	await embeddingInit;
}

async function ensureRerankProvider(): Promise<void> {
	if (!RERANK_ENABLED || rerankProvider || rerankInitAttempted) return;
	rerankInitAttempted = true;
	try {
		rerankProvider = await createTransformersRerankProvider();
		log("rerank: cross-encoder loaded (two-stage relevance active for the folded shortlist)");
	} catch (e: any) {
		rerankProvider = null;
		log(`rerank DISABLED → bi-encoder/keyword: ${e?.message ?? e}`);
	}
}

// ── LLM summary provider (async, off the critical path; deterministic digests until it lands) ──
// Selection mirrors the_conductor's `buildSummaryProvider`: an explicit ACCORDION_SUMMARY_PROVIDER
// wins; otherwise we prefer a configured CLOUD key (Anthropic → Gemini) and fall back to
// deterministic digests. Ollama is opt-in (ACCORDION_SUMMARY_PROVIDER=ollama) so an unconfigured
// run never spams a local endpoint that may not be up.
function buildSummaryProvider(): SummaryProvider | undefined {
	const pref = (process.env.ACCORDION_SUMMARY_PROVIDER || "").toLowerCase();
	if (pref === "none" || process.env.ACCORDION_SUMMARIES === "0" || process.env.ACCORDION_SUMMARIES === "false") return undefined;
	if (pref === "ollama")
		return createOllamaSummaryProvider({
			baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
			model: process.env.OLLAMA_SUMMARY_MODEL || DEFAULT_OLLAMA_MODEL,
		});
	if (pref === "anthropic") return createHaikuSummaryProvider();
	if (pref === "gemini") return createGeminiSummaryProvider();
	return createHaikuSummaryProvider() ?? createGeminiSummaryProvider() ?? undefined;
}
const summaryProvider = buildSummaryProvider();

// ── Auto-discovery heartbeat (mirrors registry_root in app/src-tauri/src/lib.rs) ──
const REG_DIR = join(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");
const REG_FILE = join(REG_DIR, `${ID}.json`);
const startedAt = Date.now();

function advertise(): void {
	mkdirSync(REG_DIR, { recursive: true });
	const entry = {
		registryProtocol: 1,
		conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
		id: ID,
		label: LABEL,
		url: URL,
		pid: process.pid,
		startedAt,
		heartbeatAt: Date.now(),
	};
	const tmp = `${REG_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry, null, 2));
	renameSync(tmp, REG_FILE);
}
advertise();
const heartbeat = setInterval(advertise, 5_000);

function shutdown(): void {
	clearInterval(heartbeat);
	try {
		rmSync(REG_FILE, { force: true });
	} catch {
		/* already gone */
	}
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

interface View {
	blocks: ViewBlock[];
	budget: number;
	contextWindow: number | null;
	liveTokens: number;
	protectedFromIndex: number;
	protectTokens: number;
	rev: number;
}

interface ConnState {
	accState: AccordionState;
	deps: ConductorDependencies;
	lastSig: string | null;
	lastView: View | null;
	pendingRev: number;
	warmInFlight: boolean;
}

function freshState(): ConnState {
	return {
		accState: createAccordionState(),
		// Phase 3 injects summaryProvider; embeddings/rerank warm the state caches directly.
		deps: { log },
		lastSig: null,
		lastView: null,
		pendingRev: -1,
		warmInFlight: false,
	};
}

/** Kick the async warm (bi-encoder embeddings + cross-encoder rerank of the folded shortlist)
 *  for the current view, then re-plan with the now-semantic caches. Mirrors the_conductor's
 *  extension flow: `warmEmbeddings(all blocks + prompt)` then `warmRerank(prompt, folded shortlist)`.
 *  Best-effort and bounded — `computeFoldPlan` reads whatever landed and otherwise falls back. */
function maybeWarm(ws: import("ws").WebSocket, state: ConnState): void {
	if (state.warmInFlight || !state.lastView || EMBEDDINGS_DISABLED) return;
	const view = state.lastView;
	const prompt = latestPrompt(view.blocks);
	const blocks = viewToParsed(view.blocks).blocks;
	state.warmInFlight = true;
	void (async () => {
		await ensureEmbeddingProvider();
		if (embeddingProvider) {
			state.deps.embeddingProvider = embeddingProvider;
			const timeoutMs = embeddingWarmedOnce ? 2000 : 10_000;
			await warmEmbeddings(blocks, prompt, embeddingProvider, state.accState, timeoutMs);
			embeddingWarmedOnce = true;
		}
		await ensureRerankProvider();
		if (rerankProvider) {
			const foldedSet = new Set(state.accState.foldedBlockIds);
			const candidates = blocks.filter((b) => foldedSet.has(b.id)).map((b) => b.text);
			if (candidates.length > 0) {
				try {
					await warmRerank(prompt, candidates, rerankProvider, state.accState);
				} catch {
					/* best-effort; falls back to relevance() */
				}
			}
		}
		pruneEmbeddingCache(state.accState, blocks, prompt);
	})()
		.catch((e) => log(`warm failed: ${e?.message ?? e}`))
		.finally(() => {
			state.warmInFlight = false;
			recomputeAndSend(ws, state, state.lastView?.rev ?? -1);
		});
}

/** Plan the current view, translate to commands, and send IFF the desired state changed
 *  (holding otherwise keeps the agent's prompt prefix cache-warm). */
function recomputeAndSend(ws: import("ws").WebSocket, state: ConnState, rev: number): void {
	const view = state.lastView;
	if (!view || ws.readyState !== ws.OPEN) return;

	const prompt = latestPrompt(view.blocks);
	const parsed = viewToParsed(view.blocks);
	const plan = computeFoldPlan(
		{
			parsed,
			incomingPrompt: prompt,
			budgetTokens: view.budget,
			state: state.accState,
			offLimitsIds: offLimitsIds(view.blocks),
		},
		state.deps,
	);

	// Persist the chosen levels so the NEXT pass sees them as prior (hysteresis / proactive-unfold).
	applyPlanToState(state.accState, plan);

	sendStatus(ws, state, view, plan, parsed.blocks, prompt);

	const sig = planSignature(plan);
	if (sig === state.lastSig) return; // no change → hold

	const commands = buildCommands(plan, parsed.blocks, state.accState, state.deps, prompt);
	ws.send(JSON.stringify({ type: "conductor/commands", rev, commands }));
	state.lastSig = sig;
	state.pendingRev = rev;
	log(
		`plan: ${commands.length} cmds · target ${(plan.foldTarget * 100).toFixed(0)}% · ` +
			`assembled ~${plan.assembledTokens.toLocaleString()}/${view.budget.toLocaleString()} tok`,
	);
}

/**
 * Surface the conductor's state to the HUMAN via `conductor/status`. This is where the
 * fact ledger + relevance TOC + folded-turn ranges live now: the_conductor injected them into
 * the agent's first assistant message, but Accordion's command vocabulary can only edit existing
 * blocks (no synthetic-header insert), so they cannot reach the agent through the contract. They
 * remain useful to the human watching the map, so we report them here. (The agent still learns
 * a fold is recoverable from the host's own `{#code FOLDED}` tags + recall/unfold tools.)
 */
function sendStatus(
	ws: import("ws").WebSocket,
	state: ConnState,
	view: View,
	plan: ReturnType<typeof computeFoldPlan>,
	blocks: import("./strategy.ts").ContextBlock[],
	prompt: string,
): void {
	if (ws.readyState !== ws.OPEN) return;
	const cap = view.contextWindow ? Math.min(view.budget, view.contextWindow) : view.budget;
	const pct = cap > 0 ? Math.round((plan.assembledTokens / cap) * 100) : 0;
	const folded = [...plan.levels.values()].filter((l) => l > 0).length;
	const pressure = pct < 70 ? "comfortable" : pct < 85 ? "normal" : "tight";

	const foldedTurns = [
		...new Set(blocks.filter((b) => (plan.levels.get(b.id) ?? 0) > 0).map((b) => b.turn)),
	].sort((a, b) => a - b);

	const text =
		`${pct}% · target ${(plan.foldTarget * 100).toFixed(0)}% · ${folded} folded · ` +
		`${plan.groups.size} groups · ${pressure}`;
	ws.send(
		JSON.stringify({
			type: "conductor/status",
			text,
			metrics: {
				fullness: pct,
				foldTarget: Math.round(plan.foldTarget * 100),
				folded,
				groups: plan.groups.size,
				pressure,
				foldedTurns: foldedTurns.length ? formatTurnRanges(foldedTurns) : "",
				// Human-only legibility for the agent-facing header that the contract cannot carry.
				factLedger: buildFactLedger(blocks).slice(0, 600),
				relevanceTOC: foldedTurns.length
					? buildRelevanceTOC(blocks, new Set(foldedTurns), prompt, state.accState).slice(0, 600)
					: "",
			},
		}),
	);
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

/** Record a human/agent override as a manual change so it (a) grants a one-pass grace period
 *  (the conductor won't immediately re-touch it) and (b) feeds the calibrator: an UNFOLD by
 *  human/agent is a correction that opens the fold-target lens. We infer direction from the
 *  view — `agentUnfold` is always an unfold; a `humanOverride` on a block that is held-and-live
 *  is an unfold/pin (correction), otherwise a manual fold (grace only). */
function recordOverride(state: ConnState, ids: string[], event: "agentUnfold" | "humanOverride"): void {
	const view = state.lastView;
	if (!view) return;
	const turn = view.blocks.reduce((mx, b) => Math.max(mx, b.turn), 0);
	const heldLive = new Set(view.blocks.filter((b) => b.held && !b.folded).map((b) => b.id));
	for (const id of ids) {
		const isUnfold = event === "agentUnfold" || heldLive.has(id);
		state.accState.manualChanges.push({
			blockId: id,
			action: isUnfold ? "unfold" : "fold",
			actor: event === "agentUnfold" ? "agent" : "you",
			turn,
		});
	}
	state.accState.manualChanges = state.accState.manualChanges.slice(-1000);
	state.lastSig = null; // force a fresh emit next pass
}

wss.on("connection", (ws) => {
	const state = freshState();
	// Wire async LLM digests: when a summary lands, upgrade the digest in place by re-planning.
	state.deps = {
		log,
		summaryProvider,
		onSummary: () => {
			state.lastSig = null;
			recomputeAndSend(ws, state, state.lastView?.rev ?? -1);
		},
	};
	log("Accordion connected");

	ws.send(
		JSON.stringify({
			type: "conductor/hello",
			conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
			id: ID,
			label: LABEL,
			wants: { content: "full" },
			// Collaborative: no locks. Human/agent overrides always win.
		}),
	);

	ws.on("message", (raw) => {
		let msg: any;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "host/commandResult") {
			// A clamp means the host refused part of our desired state (human override / protected /
			// grouped / not-foldable). Force a fresh emit next pass; the next plan self-heals from
			// the view's flags (offLimitsIds already excludes held/protected/grouped).
			if ((msg.reports || []).length) state.lastSig = null;
			return;
		}

		if (msg.type === "host/event") {
			if (msg.event === "agentUnfold" || msg.event === "humanOverride") {
				recordOverride(state, msg.ids || [], msg.event);
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
		// Act now with whatever relevance we have (keyword defends the budget before embeddings
		// land), then kick the async warm so the next pass is semantic.
		recomputeAndSend(ws, state, msg.rev);
		maybeWarm(ws, state);
	});

	ws.on("close", () => log("Accordion disconnected"));
});

log(`${LABEL} listening on ${URL}`);
log(
	`advertised at ${REG_FILE} · relevance: keyword` +
		`${EMBEDDINGS_DISABLED ? "" : " → embeddings"}${RERANK_ENABLED ? " → rerank" : ""}` +
		` · summaries: ${summaryProvider ? "on" : "deterministic"}`,
);

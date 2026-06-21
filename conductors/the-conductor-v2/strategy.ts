/*
 * strategy.ts — the_conductor's context strategy, VENDORED VERBATIM from
 * the_conductor/src/conductor.ts, with exactly one structural change for the Accordion port:
 * `runConductor(messages) → rewritten messages` is refactored into the pure
 * `computeFoldPlan(ParsedContext) → fold levels + groups`. The host (Accordion) now owns message
 * assembly, the protected tail, and persistence, so the original message-mutation tail
 * (`cloneMessages` / `applyFoldedContent`) and the agent-facing header injection
 * (`buildContextAwarenessHeader`) were removed — the contract can't carry them (see README).
 *
 * Everything else — scoring, the self-calibrating fold-target band, trim/digest/salience,
 * relevance (keyword/embedding/rerank), the providers, the fact ledger / TOC — is unchanged.
 * A few pi-message helpers (`parseMessages`, `lastCompletedTurnFromMessages`,
 * `applyDecisionsToState`) are retained from the source for completeness but are unused by this
 * conductor (the adapter feeds blocks directly). Do not "tidy" the strategy body: keeping it a
 * faithful copy is the point.
 */
import { createHash } from "node:crypto";

declare const process:
	| {
			env?: Record<string, string | undefined>;
	  }
	| undefined;

export type AgentMessage = Record<string, any>;

export type BlockKind = "user" | "text" | "thinking" | "tool_call" | "tool_result";
/** 0 = full · 1 = trim · 2 = digest · 3 = group member marker */
export type FoldLevel = 0 | 1 | 2 | 3;
export type ConductorActor = "conductor";
export type DecisionAction = "fold" | "unfold" | "pin";
export type HumanActor = "you" | "agent";

export interface Turn {
	index: number;
	messageIndexes: number[];
	tokens: number;
}

export interface ParsedContext {
	preamble: AgentMessage[];
	turns: Turn[];
	blocks: ContextBlock[];
}

interface SourceRef {
	messageIndex: number;
	contentIndex?: number;
	field: "content" | "thinking" | "tool_result";
}

export interface ContextBlock {
	id: string;
	messageKey?: string;
	kind: BlockKind;
	turn: number;
	order: number;
	text: string;
	tokens: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	source: SourceRef;
}

export interface LastCompletedTurn {
	index: number;
	messages: AgentMessage[];
	tokens?: number;
}

export interface ManualChange {
	blockId: string;
	action: "fold" | "unfold" | "pin" | "unpin";
	actor: HumanActor | ConductorActor;
	turn: number;
}

export interface CalibrationEvent {
	turn: number;
	from: number;
	to: number;
	corrections: number;
	reason: "correction" | "decay" | "hold" | "pinned";
}

export interface ConductorConfig {
	budgetTokens: number;
	workingTailTokens: number;
	foldTargetMin: number;
	foldTargetMax: number;
	foldTargetInitial: number;
	summaryModel: string;
	ollamaBaseUrl: string;
	ollamaModel: string;
	embeddingModel: string;
	summariesEnabled: boolean;
	embeddingsEnabled: boolean;
	summaryTimeoutMs: number;
}

export interface AccordionState {
	foldedBlockIds: string[];
	pinnedBlockIds: string[];
	pinnedTurnIndexes: number[];
	summaryCache: Record<string, string>;
	pendingSummaryHashes: string[];
	manualChanges: ManualChange[];
	missingApiKeyLogged?: boolean;
	/** Short provider failure message for live UI (summary/embedding). */
	providerError?: string;
	embeddingCache: Record<string, number[]>;
	/** Phase 2 two-stage relevance: cross-encoder rerank scores in [0,1], keyed by
	 *  `${textHash(prompt)}::${textHash(candidate)}`. Warmed in the async pre-pass
	 *  (warmRerank) and read synchronously by the unfold path. */
	rerankCache: Record<string, number>;
	/** Graduated fold level per block id; absent or 0 means full. */
	foldLevels: Record<string, FoldLevel>;
	/** Live self-calibrated fold target inside [FOLD_TARGET_MIN, FOLD_TARGET_MAX]. */
	foldTargetCalibrated: number;
	/** Last turn the calibrator ticked, so same-turn re-runs are idempotent. */
	lastCalibrationTurn: number;
	/** Turns on which the relative-outlier rule fired; counted as correction events. */
	recentProactiveUnfoldTurns: number[];
	/** Whether the previous run actually exercised folding pressure. */
	lastRunHadPressure: boolean;
	/** Whether the previous pressure-active run assembled within budget. */
	lastRunWithinBudget: boolean;
	/** Recent calibration ticks for the UI/decision log (capped). */
	calibrationEvents: CalibrationEvent[];
	/** @deprecated Conductor-managed pins are retired — the desired-state pipeline uses
	 *  hysteresis (HYSTERESIS_MARGIN) to prevent fold/unfold thrash instead. The field is
	 *  retained as optional so older persisted sessions deserialize cleanly; it is never read. */
	conductorPins?: Record<string, { turn: number; reason: string }>;
	/**
	 * Human-created multiblock folds (groups). Each group references a contiguous run of
	 * member block ids and carries its own `folded` flag. While a group is folded the
	 * Conductor must SKIP its members (the group's summary is what reaches the model,
	 * not the per-block digest). User-only for now; the Conductor never creates groups.
	 */
	groups: AccordionGroup[];
	/** Runtime Conductor settings overlay; defaults from compile-time constants. */
	config: ConductorConfig;
}

/** A human-created multiblock fold, mirroring the GUI's `Group` and the wire's `WireGroup`. */
export interface AccordionGroup {
	id: string;
	memberIds: string[];
	folded: boolean;
}

export interface ConductorInput {
	messages: AgentMessage[];
	incomingPrompt: string;
	lastCompletedTurn: LastCompletedTurn | null;
	budgetTokens: number;
	state: AccordionState;
	workingTailTokens?: number;
}

export interface FoldDecision {
	blockId: string;
	action: DecisionAction;
	actor: ConductorActor | HumanActor;
	reason: string | string[];
	turn: number;
	kind: BlockKind;
	callId?: string;
	/** Fold level after this decision (0 full · 1 trim · 2 digest · 3 group member). */
	level?: FoldLevel;
	/** Fold level before this decision. */
	fromLevel?: FoldLevel;
}

export interface ConductorOutput {
	messages: AgentMessage[];
	decisions: FoldDecision[];
	warnings: string[];
	/** Block ids that were proactively unfolded by the relative-outlier rule. */
	proactiveUnfolds: string[];
	/** The calibrated fold target used (or that would be used) for this run. */
	foldTarget: number;
	/** Estimated tokens of the assembled context this run produced. */
	assembledTokens: number;
	/** Per-unit scoring trace for the dashboard. One row per FoldUnit, recording the
	 *  conductor's deterministic "thinking" for this turn — kindWeight/overlap/recency
	 *  components, composite score, foldable y/n, the fold-level chosen, and the level
	 *  it had before this turn. Empty when the conductor short-circuits (no pressure). */
	unitTrace: FoldUnitTrace[];
}

/** Wire-equivalent of an internal FoldUnit, enriched with kindWeight/recency
 *  (computed during scoring) and the level transition for this turn. Stable
 *  identity: `id` is `pair:<callId>` for tool pairs, `malformed:<blockId>` for
 *  unpaired tool blocks, the block id otherwise — joins on `blockIds[]`. */
export interface FoldUnitTrace {
	id: string;
	blockIds: string[];
	foldable: boolean;
	reason: string;
	kindWeight: number;
	overlap: number;
	recency: number;
	score: number;
	fullTokens: number;
	foldedTokens: number;
	trimTokens: number;
	trimEligible: boolean;
	level: FoldLevel;
	fromLevel: FoldLevel;
	/** True iff the unit was genuinely foldable this turn — `canFoldUnit`: foldable kind,
	 *  not already fully folded, and not pinned / protected-tail / grace / in a folded group.
	 *  This is the denominator for fold-coverage; `foldable` alone is only raw kind-eligibility. */
	eligible?: boolean;
	/** Which relevance stage produced this unit's score: 1 = keyword, 2 = embedding,
	 *  3 = cross-encoder rerank. Absent for non-eligible units. */
	stage?: 1 | 2 | 3;
	/** The effective fold cutoff (`unitCutoffs.full`) the unit's relevance was compared
	 *  against in the stage-3 desire pass. Absent for non-eligible / low-signal units. */
	threshold?: number;
}

export interface SummaryRequest {
	block: ContextBlock;
	hash: string;
	digest: string;
}

export type SummaryProvider = (request: SummaryRequest) => Promise<string>;

/** Batch embedding function: given N texts, return N L2-normalized float vectors. */
export type EmbeddingProvider = (texts: string[]) => Promise<number[][]>;

/** Cross-encoder rerank function: given a query and N candidate texts, return N
 *  relevance scores in [0,1] (sigmoid-normalized). Used for the second, precise
 *  stage of two-stage relevance on the unfold shortlist. */
export type RerankProvider = (query: string, candidates: string[]) => Promise<number[]>;

export interface ConductorDependencies {
	summaryProvider?: SummaryProvider;
	embeddingProvider?: EmbeddingProvider;
	onSummary?: (hash: string, summary: string) => void;
	log?: (message: string) => void;
	now?: () => number;
	/** Override UNFOLD_RELATIVE_MARGIN at call time (also readable from env ACCORDION_UNFOLD_MARGIN). */
	unfoldMargin?: number;
	/** Override UNFOLD_SEMANTIC_FLOOR at call time (also readable from env ACCORDION_UNFOLD_FLOOR).
	 *  In the desired-state pipeline this is the low-signal relevance floor (stage 2/3). */
	unfoldFloor?: number;
	/** Pin the fold target, disabling self-calibration (also readable from env ACCORDION_FIXED_TARGET). */
	fixedFoldTarget?: number;
	/** Override HYSTERESIS_MARGIN at call time (also readable from env ACCORDION_HYSTERESIS). */
	hysteresisMargin?: number;
	/** Override the resolved (post-calibration) stage-3 Full cutoff (env ACCORDION_DESIRE_FULL_CUT). */
	desireFullCut?: number;
	/** Override the resolved (post-calibration) stage-3 Trim cutoff (env ACCORDION_DESIRE_TRIM_CUT). */
	desireTrimCut?: number;
}

export interface OpenAICompatibleSummaryProviderOptions {
	baseUrl: string;
	model: string;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export interface OllamaSummaryProviderOptions {
	baseUrl?: string;
	model?: string;
	timeoutMs?: number;
}

export interface PromptWeights {
	kind: number;
	keyword: number;
	recency: number;
	foldTargetRatio: number;
}

export const CHARS_PER_TOKEN = 4;
export const BLOCK_OVERHEAD = 4;
export const DEFAULT_BUDGET_TOKENS = 150_000;
export const WORKING_TAIL_TOKENS = 20_000;
export const MAX_EMBEDDING_CACHE_ENTRIES = 1_000;
/** Calibrated fold target band. The Conductor self-calibrates the fold target
 *  inside [FOLD_TARGET_MIN, FOLD_TARGET_MAX]: correction events (human, agent,
 *  or proactive unfolds) push it up (fold less); quiet pressure-active turns
 *  decay it down (fold more). Pin via env ACCORDION_FIXED_TARGET or
 *  ConductorDependencies.fixedFoldTarget. */
export const FOLD_TARGET_MIN = 0.6;
export const FOLD_TARGET_MAX = 0.92;
export const FOLD_TARGET_INITIAL = 0.8;
export const CALIBRATION_UP_STEP = 0.04;
export const CALIBRATION_UP_MAX_PER_TURN = 0.08;
export const CALIBRATION_DOWN_STEP = 0.01;
export const MAX_CALIBRATION_EVENTS = 50;
/** Graduated fold levels: 0 = full, 1 = trim (structured excerpt), 2 = digest
 *  (salience digest or cached LLM summary), 3 = group member (one-line marker;
 *  the first unit of the group carries the group-prefixed digest). */
export const TRIM_TARGET_RATIO = 0.25;
export const TRIM_MIN_TOKENS = 240;
export const GROUP_MIN_UNITS = 3;
export const GROUP_MEMBER_MARKER = "· folded into the group digest above";
export const UNFOLD_KEYWORD_THRESHOLD = 0.5;
/** Relative-outlier margin: a folded block is an unfold candidate only if its
 *  relevance exceeds (median_relevance_of_all_folded_blocks + UNFOLD_RELATIVE_MARGIN).
 *  Override at runtime via env var ACCORDION_UNFOLD_MARGIN or ConductorDependencies.unfoldMargin. */
export const UNFOLD_RELATIVE_MARGIN = 0.08;
/** Absolute safety floor for the cosine path: a folded block won't be unfolded unless
 *  its cosine relevance also clears this floor, regardless of the relative test.
 *  Prevents the outlier rule from firing when all relevance values are uniformly low.
 *  Override via env var ACCORDION_UNFOLD_FLOOR or ConductorDependencies.unfoldFloor. */
export const UNFOLD_SEMANTIC_FLOOR = 0.30;
/** Default embedding model (384d, 256-token input cap).
 *  Upgrade: "nomic-ai/nomic-embed-text-v1.5" (768d, 8k ctx) but requires
 *  "search_document:" / "search_query:" prefixes on inputs. */
export const EMBEDDING_MODEL = process?.env?.ACCORDION_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
export const UNFOLD_FEEDBACK_TURNS = 5;
export const HIGH_UNFOLD_RATE = 2;
export const SUMMARY_MODEL = "claude-haiku-4-5";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";
export const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;
/** Minimum pairwise digest-text keyword overlap for semantic group formation (second pass). */
export const SEMANTIC_GROUP_OVERLAP_THRESHOLD = 0.4;
/** Each risk category (commands/paths/exact_values/decisions) in a digest's suffix
 *  lowers the effective proactive-unfold floor by this amount. */
export const RISK_FLOOR_BONUS = 0.1;
/** The effective unfold floor never drops below this, regardless of risk bonus. */
export const RISK_FLOOR_MIN = 0.1;

/** Desired-state pipeline (Option C). Stage 3 maps a unit's relevance through two
 *  calibration-modulated cutoffs to a desired fold level (Full/Trim/Digest). The
 *  cutoffs slide within these bands as the calibrated fold target moves across
 *  [FOLD_TARGET_MIN..MAX]: a higher target (after corrections) lowers the cutoffs so
 *  more units stay Full/Trim (fold less); quiet decay raises them (fold more). */
export const DESIRE_FULL_CUT_HI = 0.55;
export const DESIRE_FULL_CUT_LO = 0.35;
export const DESIRE_TRIM_CUT_HI = 0.3;
export const DESIRE_TRIM_CUT_LO = 0.15;
/** Stage 5 anti-thrash: a unit only leaves its prior persisted level when relevance
 *  crosses the gating cutoff by more than this margin. Replaces the conductor-pins
 *  subsystem — borderline units stay put instead of fold/unfold flickering. */
export const HYSTERESIS_MARGIN = 0.05;
/** Below this relevance, the incoming prompt carries no usable signal; stage 3 holds
 *  prior levels and lets stage 4 (budget) drive folding. Mirrors the unfold floor. */
export const LOW_SIGNAL_FLOOR = UNFOLD_SEMANTIC_FLOOR;

/** Lower value means lower durable value and therefore more foldable. */
export const FOLD_RANK: Record<BlockKind, number> = {
	tool_result: 0,
	thinking: 1,
	text: 2,
	tool_call: 3,
	user: 4,
};

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"i",
	"in",
	"is",
	"it",
	"me",
	"of",
	"on",
	"or",
	"our",
	"that",
	"the",
	"this",
	"to",
	"we",
	"with",
	"you",
	"your",
]);

export function defaultConductorConfig(): ConductorConfig {
	return {
		budgetTokens: DEFAULT_BUDGET_TOKENS,
		workingTailTokens: WORKING_TAIL_TOKENS,
		foldTargetMin: FOLD_TARGET_MIN,
		foldTargetMax: FOLD_TARGET_MAX,
		foldTargetInitial: FOLD_TARGET_INITIAL,
		summaryModel: "",
		ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
		ollamaModel: DEFAULT_OLLAMA_MODEL,
		embeddingModel: EMBEDDING_MODEL,
		summariesEnabled: true,
		embeddingsEnabled: true,
		summaryTimeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS,
	};
}

export function mergeConductorConfig(partial?: Partial<ConductorConfig>): ConductorConfig {
	const defaults = defaultConductorConfig();
	if (!partial) return { ...defaults };
	return { ...defaults, ...partial };
}

export function createAccordionState(seed: Partial<AccordionState> = {}): AccordionState {
	// Membership source of truth is foldedBlockIds (manual fold/unfold paths edit
	// it directly); foldLevels records depth for members. Stale level entries for
	// ids no longer in membership are dropped, and members without a recorded
	// depth migrate to level 2 (digest), matching the legacy binary system.
	const seededLevels = seed.foldLevels ?? {};
	const membership = seed.foldedBlockIds ?? Object.keys(seededLevels);
	const foldLevels: Record<string, FoldLevel> = {};
	for (const id of membership) {
		const normalized = normalizeLevel(seededLevels[id] ?? 2);
		foldLevels[id] = normalized > 0 ? normalized : 2;
	}
	const config = mergeConductorConfig(seed.config);
	const foldBand = foldTargetBand(config);
	return {
		foldedBlockIds: Object.keys(foldLevels),
		pinnedBlockIds: [...(seed.pinnedBlockIds ?? [])],
		pinnedTurnIndexes: [...(seed.pinnedTurnIndexes ?? [])],
		summaryCache: { ...(seed.summaryCache ?? {}) },
		pendingSummaryHashes: [...(seed.pendingSummaryHashes ?? [])],
		manualChanges: [...(seed.manualChanges ?? [])],
		missingApiKeyLogged: seed.missingApiKeyLogged ?? false,
		providerError: seed.providerError,
		embeddingCache: { ...(seed.embeddingCache ?? {}) },
		rerankCache: { ...(seed.rerankCache ?? {}) },
		foldLevels,
		foldTargetCalibrated: clampFoldTarget(seed.foldTargetCalibrated ?? config.foldTargetInitial, foldBand),
		lastCalibrationTurn: seed.lastCalibrationTurn ?? -1,
		recentProactiveUnfoldTurns: [...(seed.recentProactiveUnfoldTurns ?? [])],
		lastRunHadPressure: seed.lastRunHadPressure ?? false,
		lastRunWithinBudget: seed.lastRunWithinBudget ?? false,
		calibrationEvents: [...(seed.calibrationEvents ?? [])].slice(-MAX_CALIBRATION_EVENTS),
		conductorPins: { ...(seed.conductorPins ?? {}) },
		groups: (seed.groups ?? []).map((g: AccordionGroup) => ({ ...g, memberIds: [...g.memberIds] })),
		config,
	};
}

export function normalizeLevel(level: unknown): FoldLevel {
	const n = typeof level === "number" ? Math.round(level) : 0;
	if (n <= 0) return 0;
	if (n >= 3) return 3;
	return n as FoldLevel;
}

export interface FoldTargetBand {
	min?: number;
	max?: number;
	initial?: number;
}

export function foldTargetBand(config: ConductorConfig): FoldTargetBand {
	return {
		min: config.foldTargetMin,
		max: config.foldTargetMax,
		initial: config.foldTargetInitial,
	};
}

export function clampFoldTarget(value: number, band: FoldTargetBand = {}): number {
	const min = band.min ?? FOLD_TARGET_MIN;
	const max = band.max ?? FOLD_TARGET_MAX;
	const initial = band.initial ?? FOLD_TARGET_INITIAL;
	if (!Number.isFinite(value)) return initial;
	return Math.min(max, Math.max(min, value));
}

/** Tick the self-calibrating fold target for this turn. Pure given state + deps:
 *  correction events (manual/agent unfolds and proactive unfolds inside the
 *  feedback window, not yet counted) push the target up by CALIBRATION_UP_STEP
 *  each, capped at CALIBRATION_UP_MAX_PER_TURN; a pressure-active quiet turn
 *  that previously assembled within budget decays it by CALIBRATION_DOWN_STEP.
 *  Idempotent within a turn via state.lastCalibrationTurn. */
export function calibrateFoldTarget(
	state: AccordionState,
	currentTurn: number,
	deps: ConductorDependencies = {},
): number {
	const band = foldTargetBand(state.config);
	const rawPinned = parseFloat(process?.env?.ACCORDION_FIXED_TARGET ?? "");
	const pinned = deps.fixedFoldTarget ?? (!isNaN(rawPinned) ? rawPinned : undefined);
	if (pinned !== undefined) {
		const target = clampFoldTarget(pinned, band);
		if (state.foldTargetCalibrated !== target) {
			recordCalibration(state, { turn: currentTurn, from: state.foldTargetCalibrated, to: target, corrections: 0, reason: "pinned" });
			state.foldTargetCalibrated = target;
		}
		return target;
	}

	const from = clampFoldTarget(state.foldTargetCalibrated ?? state.config.foldTargetInitial, band);
	if (state.lastCalibrationTurn >= currentTurn) return from;

	const inWindow = (turn: number) =>
		turn >= state.lastCalibrationTurn && turn < currentTurn && currentTurn - turn <= UNFOLD_FEEDBACK_TURNS;
	const manualCorrections = state.manualChanges.filter(
		(change) => change.action === "unfold" && (change.actor === "you" || change.actor === "agent") && inWindow(change.turn),
	).length;
	const proactiveCorrections = state.recentProactiveUnfoldTurns.filter(inWindow).length;
	const corrections = manualCorrections + proactiveCorrections;

	let to = from;
	let reason: CalibrationEvent["reason"] = "hold";
	if (corrections > 0) {
		to = clampFoldTarget(from + Math.min(CALIBRATION_UP_MAX_PER_TURN, corrections * CALIBRATION_UP_STEP), band);
		reason = "correction";
	} else if (state.lastRunHadPressure && state.lastRunWithinBudget) {
		to = clampFoldTarget(from - CALIBRATION_DOWN_STEP, band);
		reason = "decay";
	}

	state.lastCalibrationTurn = currentTurn;
	if (to !== from || reason !== "hold") {
		recordCalibration(state, { turn: currentTurn, from, to, corrections, reason });
	}
	state.foldTargetCalibrated = to;
	return to;
}

function recordCalibration(state: AccordionState, event: CalibrationEvent): void {
	state.calibrationEvents.push(event);
	if (state.calibrationEvents.length > MAX_CALIBRATION_EVENTS) {
		state.calibrationEvents = state.calibrationEvents.slice(-MAX_CALIBRATION_EVENTS);
	}
}

export function estTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function tokensOf(s: string): number {
	return estTokens(s) + BLOCK_OVERHEAD;
}

function clip(s: string, n: number): string {
	const m = Math.max(1, n);
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= m ? t : t.slice(0, m - 3).trimEnd() + "...";
}

/** Copy of app/src/lib/engine/digest.ts foldCode. Keep in lockstep with the host. */
export function foldCode(id: string): string {
	let h = 0x811c9dc5; // FNV-1a 32-bit
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

export function foldTag(id: string): string {
	return `{#${foldCode(id)} FOLDED}`;
}

function firstLine(s: string, n = 100): string {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}

function decisionSentence(text: string, maxChars = 180): string {
	const sentences = text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const selected = sentences.find((sentence) =>
		/\b(?:actual|belongs to|blamed|came from|command we kept|decision|decided|exact command|favou?rite|favou?red|final|liked|preferred|selected|chosen|wanted|we chose|we will)\b/i.test(sentence),
	);
	return selected ? clip(selected, maxChars) : "";
}

function salienceTokens(text: string, maxItems = 5, maxChars = 120): string {
	const seen = new Set<string>();
	const result: string[] = [];
	let totalChars = 0;
	const add = (s: string) => {
		const t = s.trim();
		if (!t || seen.has(t) || result.length >= maxItems || totalChars + t.length > maxChars) return;
		seen.add(t); result.push(t); totalChars += t.length;
	};
	// SCREAMING-CASE hyphenated identifiers (e.g. MANGO-WHISPER-9, AUTH-TOKEN)
	for (const m of text.matchAll(/[A-Z]{2,}(?:-[A-Z0-9]+)+/g)) add(m[0]);
	// key: value and key=value pairs
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!STOPWORDS.has(key.toLowerCase()) && val.length > 2) add(`${key}=${val}`);
	}
	// Filenames with extensions
	for (const m of text.matchAll(/\b[\w.-]+\.\w{1,6}\b/g)) add(m[0]);
	// Version / hex literals
	for (const m of text.matchAll(/\bv?\d+\.\d+[\d.]*\b|\b0x[0-9a-fA-F]+\b/g)) add(m[0]);
	// Error markers
	for (const m of text.matchAll(/\b(?:error|exception|failed|panic)[: ]+\S+/gi)) add(m[0].slice(0, 30));
	// HTTP routes and API endpoints. Keep this bounded: sentence-wide route
	// regexes can backtrack badly on huge minified or repetitive tool outputs.
	for (const m of text.matchAll(/\b(?:DELETE|GET|PATCH|POST|PUT)\s+\/[A-Za-z0-9_./:*-]+/g)) add(m[0]);
	// Common shell command invocations
	for (const m of text.matchAll(/\b(?:bun|cargo|deno|docker|gh|git|go|kubectl|make|node|npm|npx|pnpm|pytest|python3?|uv|yarn)\b[^\n.!?;]*/g)) {
		add(m[0]);
	}
	return result.join(" · ");
}

/** Categorize text content into salience buckets for structured digest suffixes. */
export function categorizeSalienceMarkers(text: string): {
	paths: string[];
	commands: string[];
	errors: string[];
	exact_values: string[];
	decisions: string[];
} {
	const result: { paths: string[]; commands: string[]; errors: string[]; exact_values: string[]; decisions: string[] } = {
		paths: [], commands: [], errors: [], exact_values: [], decisions: [],
	};
	const seen = new Set<string>();
	const add = (bucket: string[], val: string) => {
		const t = val.trim().slice(0, 80);
		if (!t || seen.has(t) || bucket.length >= 3) return;
		seen.add(t); bucket.push(t);
	};
	// Paths: filenames with common extensions, relative/absolute paths
	for (const m of text.matchAll(/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml|sh|env|log|conf|cfg|txt|sql|proto|lock)\b/g)) add(result.paths, m[0]);
	for (const m of text.matchAll(/(?:^|\s)((?:\.{1,2}|src|lib|app|dist|build|test|scripts?)\/[\w./-]+)/gm)) add(result.paths, m[1]);
	// Commands: lines starting with $ and common CLI invocations
	for (const m of text.matchAll(/^\s*\$\s+(.+)/gm)) add(result.commands, m[1].slice(0, 80));
	for (const m of text.matchAll(/\b(?:npm|npx|pnpm|yarn|bun|node|git|docker|kubectl|make|cargo|go|python3?|pytest|deno|uv|gh)\s+\S[^\n.!?;]{0,60}/g)) {
		add(result.commands, m[0].trim());
	}
	// Errors: explicit error markers and stack frames
	for (const m of text.matchAll(/\b(?:Error|FAIL|FAILED|error|exception|panic|ENOENT|ECONNREFUSED)[: ]+[^\n]{0,60}/g)) add(result.errors, m[0].slice(0, 60));
	if (/\s+at\s+\S+\s*\(/.test(text)) add(result.errors, "stack trace");
	// Exact values: key=value / key: value pairs
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!STOPWORDS.has(key.toLowerCase()) && val.length > 2 && val.length < 60) add(result.exact_values, `${key}=${val}`);
	}
	// Decisions: sentences containing explicit decision language.
	// Leading [^.!?\n]* before the keyword causes O(n²) backtracking on long no-newline text.
	// Bound pre-context to 200 chars to keep this O(n).
	for (const m of text.matchAll(/[^.!?\n]{0,200}\b(?:decided|chose|standardized on|going with|will use|selected|picked)\b[^.!?\n]{0,200}/gi)) {
		add(result.decisions, m[0].trim().slice(0, 80));
	}
	return result;
}

function buildSalienceSuffix(text: string): string {
	const cats = categorizeSalienceMarkers(text);
	const parts: string[] = [];
	if (cats.paths.length > 0) parts.push(`paths: ${cats.paths.slice(0, 3).join(", ")}`);
	if (cats.commands.length > 0) parts.push(`commands: ${cats.commands.slice(0, 2).join(", ")}`);
	if (cats.errors.length > 0) parts.push(`errors: ${cats.errors.slice(0, 2).join(", ")}`);
	if (cats.exact_values.length > 0) parts.push(`exact_values: ${cats.exact_values.slice(0, 3).join(", ")}`);
	if (cats.decisions.length > 0) parts.push(`decisions: ${cats.decisions.slice(0, 1).join(", ")}`);
	if (parts.length === 0) return "";
	return ` ⟦${parts.join(" ∣ ")}⟧`;
}

/** Parse the structured salience suffix appended by deterministicDigest and return the
 *  risk category names present. Risk categories: commands, paths, exact_values, decisions. */
export function parseRiskFlags(digestText: string): string[] {
	// Match the last ⟦...⟧ bracket (the salience suffix, not a group or trim marker)
	const match = digestText.match(/⟦([^⟧]+)⟧\s*$/);
	if (!match) return [];
	const suffix = match[1];
	// Don't parse group/trim markers as salience suffixes
	if (/^(?:group|trim)\b/.test(suffix.trim())) return [];
	const riskCategories = ["commands", "paths", "exact_values", "decisions"] as const;
	return riskCategories.filter((cat) => suffix.includes(`${cat}:`));
}

/** Number of risk categories present in the digest's salience suffix. Used to lower the
 *  proactive-unfold effective floor: effective_floor = floor - (bonus × RISK_FLOOR_BONUS). */
export function parseSalienceRiskBonus(digestText: string): number {
	return parseRiskFlags(digestText).length;
}

export function formatTurnRanges(turns: number[]): string {
	if (turns.length === 0) return "none";
	const sorted = [...turns].sort((a, b) => a - b);
	const ranges: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const t = sorted[i];
		if (t === prev + 1) { prev = t; continue; }
		ranges.push(start === prev ? String(start) : `${start}–${prev}`);
		start = prev = t;
	}
	return ranges.join(", ");
}

// (removed in the accordion port) buildContextAwarenessHeader — the agent-facing context note was
// prepended to the first assistant message; the command contract can't insert a synthetic block.
// Pressure / target / folded-turns are surfaced to the human via `conductor/status` instead.

/** Phase 4 — fact ledger ("attention sink for facts"). H2O's documented failure:
 *  dormant tokens like credentials, config values, and IDs get near-zero attention
 *  yet are critical at generation time. The conductor always sees full block text
 *  (folding only rewrites the OUTPUT), so we harvest every high-value marker across
 *  ALL turns deterministically each run and surface it verbatim at the context head,
 *  guaranteeing a fact survives even when its turn is crushed to a group marker. */
export function buildFactLedger(blocks: ContextBlock[], maxFacts = 12): string {
	const order = ["exact_values", "decisions", "commands", "errors", "paths"] as const;
	const seen = new Set<string>();
	const byCat: Record<(typeof order)[number], { value: string; turn: number }[]> = {
		exact_values: [], decisions: [], commands: [], errors: [], paths: [],
	};
	for (const block of blocks) {
		const cats = categorizeSalienceMarkers(block.text);
		for (const cat of order) {
			for (const value of cats[cat]) {
				const key = `${cat}:${value.toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				byCat[cat].push({ value, turn: block.turn });
			}
		}
	}
	const facts: string[] = [];
	for (const cat of order) {
		for (const { value, turn } of byCat[cat]) {
			if (facts.length >= maxFacts) break;
			facts.push(`${value} (t${turn})`);
		}
		if (facts.length >= maxFacts) break;
	}
	return facts.length ? `⟦facts⟧ ${facts.join(" · ")}` : "";
}

export interface FactLedgerEntry {
	cat: "exact_values" | "decisions" | "commands" | "errors" | "paths";
	value: string;
	turn: number;
}

/** Structured variant of `buildFactLedger` for the conductor dashboard. Same
 *  category priority order as the string version, same dedupe rule (cat+value
 *  lowercased), same cap. Source of truth: `categorizeSalienceMarkers` over
 *  the full block text — exactly what the head-of-context fact strip uses. */
export function buildFactLedgerStructured(blocks: ContextBlock[], maxFacts = 12): FactLedgerEntry[] {
	const order: FactLedgerEntry["cat"][] = ["exact_values", "decisions", "commands", "errors", "paths"];
	const seen = new Set<string>();
	const byCat: Record<FactLedgerEntry["cat"], FactLedgerEntry[]> = {
		exact_values: [], decisions: [], commands: [], errors: [], paths: [],
	};
	for (const block of blocks) {
		const cats = categorizeSalienceMarkers(block.text);
		for (const cat of order) {
			for (const value of cats[cat]) {
				const key = `${cat}:${value.toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				byCat[cat].push({ cat, value, turn: block.turn });
			}
		}
	}
	const out: FactLedgerEntry[] = [];
	for (const cat of order) {
		for (const entry of byCat[cat]) {
			if (out.length >= maxFacts) return out;
			out.push(entry);
		}
	}
	return out;
}

/** Phase 5 — relevance-ordered table of contents. LongLLMLingua reorders documents
 *  to beat the lost-in-the-middle attention curve; the conductor can't physically
 *  reorder turns (tool-pair causality / provider message skeleton), so it surfaces a
 *  relevance-ranked index of surviving folded turns at the head instead. */
export function buildRelevanceTOC(
	blocks: ContextBlock[],
	foldedTurns: Set<number>,
	prompt: string,
	state: AccordionState,
	maxItems = 5,
): string {
	const byTurn = new Map<number, { rel: number; label: string }>();
	for (const block of blocks) {
		if (!foldedTurns.has(block.turn)) continue;
		const rel = relevance(block.text, prompt, state);
		const existing = byTurn.get(block.turn);
		if (!existing || rel > existing.rel) byTurn.set(block.turn, { rel, label: firstLine(block.text, 40) });
	}
	const ranked = [...byTurn.entries()]
		.filter(([, v]) => v.rel > 0)
		.sort((a, b) => b[1].rel - a[1].rel)
		.slice(0, maxItems);
	if (ranked.length === 0) return "";
	return `⟦most relevant folded⟧ ${ranked.map(([turn, v]) => `t${turn} · "${v.label}"`).join(", ")}`;
}

export interface TOCEntry {
	turn: number;
	rel: number;
	label: string;
}

/** Structured variant of `buildRelevanceTOC` for the conductor dashboard. */
export function buildRelevanceTOCStructured(
	blocks: ContextBlock[],
	foldedTurns: Set<number>,
	prompt: string,
	state: AccordionState,
	maxItems = 5,
): TOCEntry[] {
	const byTurn = new Map<number, { rel: number; label: string }>();
	for (const block of blocks) {
		if (!foldedTurns.has(block.turn)) continue;
		const rel = relevance(block.text, prompt, state);
		const existing = byTurn.get(block.turn);
		if (!existing || rel > existing.rel) byTurn.set(block.turn, { rel, label: firstLine(block.text, 40) });
	}
	return [...byTurn.entries()]
		.filter(([, v]) => v.rel > 0)
		.sort((a, b) => b[1].rel - a[1].rel)
		.slice(0, maxItems)
		.map(([turn, v]) => ({ turn, rel: v.rel, label: v.label }));
}

function getText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

const MAX_SUMMARY_INPUT_CHARS = 4_000;

function summaryPrompt(block: ContextBlock, digest: string): string {
	const text =
		block.text.length > MAX_SUMMARY_INPUT_CHARS
			? `${block.text.slice(0, MAX_SUMMARY_INPUT_CHARS)}\n[... truncated at ${MAX_SUMMARY_INPUT_CHARS} chars]`
			: block.text;
	return (
		`Summarize this Accordion ${block.kind} block for future agent context. ` +
		`Keep durable facts, decisions, filenames, errors, and outcomes. Be concise.\n\n` +
		`Fallback digest:\n${digest}\n\nFull block:\n${text}`
	);
}

export function deterministicDigest(block: ContextBlock): string {
	switch (block.kind) {
		case "user": {
			const base = `"${clip(block.text, 100)}"`;
			return base + buildSalienceSuffix(block.text);
		}
		case "text": {
			const decision = decisionSentence(block.text);
			const salience = salienceTokens(block.text);
			let base: string;
			if (decision && salience && !decision.includes(salience)) base = `${decision} | ${salience}`;
			else base = decision || salience || clip(block.text, 120);
			return base + buildSalienceSuffix(block.text);
		}
		case "thinking": {
			const tok = estTokens(block.text);
			const gist = firstLine(block.text, 80);
			const base = `thought - ~${tok} tok${gist ? " - " + gist : ""}`;
			return base + buildSalienceSuffix(block.text);
		}
		case "tool_call": {
			const base = `${block.toolName ?? "tool"}(${clip(block.text.replace(/^\S+\s*/, ""), 70)})`;
			return base + buildSalienceSuffix(block.text);
		}
		case "tool_result": {
			const name = block.toolName ?? "result";
			if (!block.text.trim()) return `${name} -> ${block.isError ? "error" : "empty"}`;
			const lines = block.text.split("\n").filter((l) => l.trim()).length;
			const tag = block.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = salienceTokens(block.text) || firstLine(block.text, 60);
			const base = `${name} -> ${tag}, ~${block.tokens} tok${peek ? " - " + peek : ""}`;
			return base + buildSalienceSuffix(block.text);
		}
	}
}

/** Address prefix that makes every fold targetable by the agent's recall/unfold
 *  tools and the human's /peek and /expand commands. */
export function foldAddress(block: ContextBlock): string {
	return `${foldTag(block.id)} \u27e6t${block.turn}\u27e7 `;
}

export function digestTokens(block: ContextBlock): number {
	return tokensOf(foldAddress(block) + deterministicDigest(block));
}

/** Segment a block's text into scorable units for extractive trim: lines first,
 *  with long prose lines further split on sentence boundaries. Deterministic so
 *  the same segments are embedded (warmEmbeddings), retained (pruneEmbeddingCache),
 *  and selected (trimmedText). */
export function segmentForTrim(text: string, maxSegments = 200): string[] {
	const segments: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.length > 240 && /[.!?]\s/.test(line)) {
			for (const sentence of line.split(/(?<=[.!?])\s+/)) {
				const s = sentence.trim();
				if (s) segments.push(s);
				if (segments.length >= maxSegments) return segments;
			}
		} else {
			segments.push(line);
		}
		if (segments.length >= maxSegments) return segments;
	}
	return segments;
}

/** A segment is "risk-bearing" when it carries a dormant-but-critical marker
 *  (command, exact value, error, decision). H2O's failure mode: these tokens get
 *  near-zero attention yet are essential at generation time, so extractive trim
 *  keeps them unconditionally. Returns the count of salience categories present
 *  (0..5) for ranking and whether any risk category is present. */
function segmentSalience(seg: string): { score: number; hasRisk: boolean } {
	const cats = categorizeSalienceMarkers(seg);
	const present = [cats.paths, cats.commands, cats.errors, cats.exact_values, cats.decisions].filter(
		(bucket) => bucket.length > 0,
	).length;
	const hasRisk =
		cats.commands.length > 0 || cats.exact_values.length > 0 || cats.errors.length > 0 || cats.decisions.length > 0;
	return { score: present / 5, hasRisk };
}

/** Level-1 fold: a query-aware extractive excerpt at ~TRIM_TARGET_RATIO of the
 *  original (coarse-to-fine, \u00e0 la LongLLMLingua / Selective Context). Instead of
 *  a blind head/tail+salience cut, segments are scored by query relevance,
 *  intrinsic salience, and serial position, then greedily selected under the same
 *  char budget. Risk-bearing segments are kept unconditionally. With `prompt`+`state`
 *  the relevance term uses cosine when the segment is in the embedding cache and
 *  keyword overlap otherwise; with no prompt it degrades to a deterministic
 *  salience+position selection \u2014 so the one-arg call (UI preview, trimTokens) stays
 *  stable and query-independent. */
export function trimmedText(block: ContextBlock, prompt?: string, state?: AccordionState): string {
	const text = block.text;
	const budgetChars = Math.max(240, Math.floor(text.length * TRIM_TARGET_RATIO));
	const segments = segmentForTrim(text);
	const n = segments.length;
	if (n <= 4) return clip(text, budgetChars);

	const useQuery = !!prompt && !!state;
	const scored = segments.map((seg, i) => {
		const rel = useQuery ? relevance(seg, prompt!, state!) : 0;
		const { score: sal, hasRisk } = segmentSalience(seg);
		const pos = i < 2 || i >= n - 2 ? 1 : 0; // serial-position effect: anchor head & tail
		const combined = (useQuery ? 0.5 * rel : 0) + 0.35 * sal + 0.15 * pos;
		return { seg, i, combined, hasRisk, len: seg.length };
	});

	const selected = new Set<number>();
	let used = 0;
	const tryAdd = (item: { i: number; len: number }) => {
		if (selected.has(item.i)) return;
		if (selected.size > 0 && used + item.len + 1 > budgetChars) return;
		selected.add(item.i);
		used += item.len + 1;
	};
	// 1. Unconditionally keep dormant-but-critical segments.
	for (const item of scored.filter((s) => s.hasRisk)) tryAdd(item);
	// 2. Anchor head and tail.
	tryAdd(scored[0]);
	tryAdd(scored[n - 1]);
	// 3. Fill remaining budget by combined score.
	for (const item of [...scored].sort((a, b) => b.combined - a.combined)) {
		if (used >= budgetChars) break;
		tryAdd(item);
	}

	const order = [...selected].sort((a, b) => a - b);
	const parts: string[] = [];
	let prev = -1;
	for (const i of order) {
		if (prev >= 0 && i > prev + 1) parts.push(`\u27ea\u2026 ${i - prev - 1} more \u2026\u27eb`);
		parts.push(segments[i]);
		prev = i;
	}
	if (prev >= 0 && prev < n - 1) parts.push("\u27ea\u2026\u27eb");
	const body = parts.join("\n");
	const capped = body.length > budgetChars ? body.slice(0, budgetChars - 3).trimEnd() + "..." : body;
	return `\u27e6trim t${block.turn}\u27e7 ${capped}`;
}

export function trimTokens(block: ContextBlock): number {
	return tokensOf(foldAddress(block) + trimmedText(block));
}

export function trimEligible(block: ContextBlock): boolean {
	return block.tokens >= TRIM_MIN_TOKENS && trimTokens(block) <= Math.floor(block.tokens * 0.5);
}

export function groupMemberText(block: ContextBlock): string {
	return `\u00b7 t${block.turn} ${GROUP_MEMBER_MARKER.slice(2)}`;
}

export function blockTokensAtLevel(block: ContextBlock, level: FoldLevel): number {
	// Accordion adaptation: only text/thinking/tool_result fold on the wire. `user` and
	// `tool_call` are never foldable (folding a tool_call would orphan its result), so they
	// never shrink — the projection must reflect that or the budget guarantee drifts.
	if (level <= 0 || block.kind === "user" || block.kind === "tool_call") return block.tokens;
	if (level === 1) return trimTokens(block);
	if (level === 3) return tokensOf(groupMemberText(block));
	return digestTokens(block);
}

export function liveTokensAtLevels(blocks: ContextBlock[], levels: Map<string, FoldLevel>): number {
	let total = 0;
	for (const block of blocks) total += blockTokensAtLevel(block, levels.get(block.id) ?? 0);
	return total;
}

function messageId(message: AgentMessage, index: number): string {
	return String(message.id ?? message.uuid ?? `__m${index}`);
}

export function parseMessages(messages: AgentMessage[]): ParsedContext {
	const preamble: AgentMessage[] = [];
	const turns: Turn[] = [];
	const blocks: ContextBlock[] = [];
	let currentTurn: Turn | null = null;
	let turn = 0;
	let order = 0;

	const beginTurn = (messageIndex: number) => {
		turn += 1;
		currentTurn = { index: turn, messageIndexes: [messageIndex], tokens: 0 };
		turns.push(currentTurn);
	};

	const includeMessage = (messageIndex: number) => {
		if (currentTurn && !currentTurn.messageIndexes.includes(messageIndex)) {
			currentTurn.messageIndexes.push(messageIndex);
		}
	};

	const push = (
		messageIndex: number,
		id: string,
		kind: BlockKind,
		text: string,
		source: SourceRef,
		extra: Partial<Pick<ContextBlock, "toolName" | "callId" | "isError">> = {},
	) => {
		if (!text && kind !== "tool_result") return;
		const block: ContextBlock = {
			id,
			kind,
			turn,
			order: order++,
			text,
			tokens: tokensOf(text),
			source,
			...extra,
		};
		blocks.push(block);
		if (currentTurn) {
			currentTurn.tokens += block.tokens;
			includeMessage(messageIndex);
		}
	};

	for (let mi = 0; mi < messages.length; mi++) {
		const message = messages[mi] as any;
		const role = message.role;
		const mid = messageId(message, mi);

		if (role === "compactionSummary" || (role !== "user" && !currentTurn)) {
			preamble.push(message);
			continue;
		}

		if (role === "user") {
			beginTurn(mi);
			push(mi, `${mid}:u`, "user", getText(message.content), {
				messageIndex: mi,
				field: "content",
			});
			continue;
		}

		if (role === "assistant") {
			includeMessage(mi);
			const content = Array.isArray(message.content) ? message.content : [];
			let ci = 0;
			for (const block of content) {
				if (block?.type === "thinking") {
					push(mi, `${mid}:${ci}`, "thinking", block.thinking || "", {
						messageIndex: mi,
						contentIndex: ci,
						field: "thinking",
					});
				} else if (block?.type === "text") {
					push(mi, `${mid}:${ci}`, "text", block.text || "", {
						messageIndex: mi,
						contentIndex: ci,
						field: "content",
					});
				} else if (block?.type === "toolCall" || block?.type === "tool_use") {
					const args = block.arguments ?? block.input ?? {};
					push(mi, `${mid}:${ci}`, "tool_call", `${block.name ?? "tool"} ${JSON.stringify(args)}`, {
						messageIndex: mi,
						contentIndex: ci,
						field: "content",
					}, {
						toolName: block.name ?? "tool",
						callId: block.id,
					});
				}
				ci++;
			}
			continue;
		}

		if (role === "toolResult") {
			includeMessage(mi);
			push(mi, `${mid}:r`, "tool_result", getText(message.content), {
				messageIndex: mi,
				field: "tool_result",
			}, {
				toolName: message.toolName || "tool",
				callId: message.toolCallId,
				isError: !!message.isError,
			});
			continue;
		}

		includeMessage(mi);
	}

	return { preamble, turns, blocks };
}

export function tokenizeForRelevance(text: string): string[] {
	const matches = text.toLowerCase().match(/[a-z0-9]+(?:[._:/\\-][a-z0-9]+)*/g) ?? [];
	return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function keywordOverlap(blockText: string, prompt: string): number {
	const promptTokens = new Set(tokenizeForRelevance(prompt));
	if (promptTokens.size === 0) return 0;
	const blockTokens = new Set(tokenizeForRelevance(blockText));
	let shared = 0;
	for (const token of promptTokens) if (blockTokens.has(token)) shared++;
	return shared / promptTokens.size;
}

export function choosePromptWeights(
	prompt: string,
	state: AccordionState,
	currentTurn: number,
	calibratedTarget: number = FOLD_TARGET_INITIAL,
): PromptWeights {
	const target = clampFoldTarget(calibratedTarget, foldTargetBand(state.config));
	let weights: PromptWeights;
	if (hasIdentifierOrError(prompt)) {
		weights = { kind: 0.3, keyword: 0.6, recency: 0.1, foldTargetRatio: target };
	} else if (referencesPast(prompt)) {
		weights = { kind: 0.25, keyword: 0.7, recency: 0.05, foldTargetRatio: target };
	} else if (isGenericContinuation(prompt)) {
		weights = { kind: 0.3, keyword: 0.2, recency: 0.5, foldTargetRatio: target };
	} else {
		weights = { kind: 0.4, keyword: 0.4, recency: 0.2, foldTargetRatio: target };
	}

	const recentUnfolds = state.manualChanges.filter(
		(change) =>
			change.action === "unfold" &&
			(change.actor === "you" || change.actor === "agent") &&
			currentTurn - change.turn <= UNFOLD_FEEDBACK_TURNS,
	).length;

	// Relevance-weight shift only: fold aggressiveness now adapts through the
	// calibrated fold target instead of a hardcoded bump.
	if (recentUnfolds >= HIGH_UNFOLD_RATE) {
		weights = normalizeWeights({
			kind: Math.max(0.05, weights.kind - 0.1),
			keyword: weights.keyword + 0.15,
			recency: Math.max(0.05, weights.recency - 0.05),
			foldTargetRatio: target,
		});
	}

	return weights;
}

function normalizeWeights(weights: PromptWeights): PromptWeights {
	const total = weights.kind + weights.keyword + weights.recency;
	return {
		kind: weights.kind / total,
		keyword: weights.keyword / total,
		recency: weights.recency / total,
		foldTargetRatio: weights.foldTargetRatio,
	};
}

function hasIdentifierOrError(prompt: string): boolean {
	return (
		/`[^`]+`/.test(prompt) ||
		/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml)\b/i.test(prompt) ||
		/\b[A-Z][A-Za-z]+Error\b/.test(prompt) ||
		/\b(?:error|exception|traceback|failed|cannot|undefined|null|enoent|econnrefused)\b/i.test(prompt) ||
		/\b[A-Za-z_$][\w$]*(?:_[\w$]+|\.[\w$]+|::[\w$]+|\([^)]*\))/.test(prompt)
	);
}

function referencesPast(prompt: string): boolean {
	return /\b(earlier|before|previously|last time|we decided|you said|we said|as discussed|from above)\b/i.test(prompt);
}

function isGenericContinuation(prompt: string): boolean {
	return /^\s*(continue|next|keep going|go on|proceed|carry on|resume)\b/i.test(prompt);
}

interface FoldUnit {
	id: string;
	blocks: ContextBlock[];
	foldable: boolean;
	reason: string;
	score: number;
	overlap: number;
	fullTokens: number;
	foldedTokens: number;
	trimTokens: number;
	trimEligible: boolean;
}

function buildFoldUnits(blocks: ContextBlock[], prompt: string, currentTurn: number, state: AccordionState): FoldUnit[] {
	const calls = new Map<string, ContextBlock[]>();
	const results = new Map<string, ContextBlock[]>();
	for (const block of blocks) {
		if (!block.callId) continue;
		if (block.kind === "tool_call") calls.set(block.callId, [...(calls.get(block.callId) ?? []), block]);
		if (block.kind === "tool_result") results.set(block.callId, [...(results.get(block.callId) ?? []), block]);
	}

	const paired = new Set<string>();
	const units: FoldUnit[] = [];
	for (const block of blocks) {
		if ((block.kind === "tool_call" || block.kind === "tool_result") && !block.callId) {
			units.push(makeUnit(`malformed:${block.id}`, [block], false, "missing tool pair id kept full", prompt, currentTurn, state));
			continue;
		}

		if (block.callId && (block.kind === "tool_call" || block.kind === "tool_result")) {
			if (paired.has(block.id)) continue;
			const call = block.kind === "tool_call" ? block : calls.get(block.callId)?.[0];
			const result = block.kind === "tool_result" ? block : results.get(block.callId)?.[0];
			if (call && result && calls.get(block.callId)?.length === 1 && results.get(block.callId)?.length === 1) {
				paired.add(call.id);
				paired.add(result.id);
				units.push(makeUnit(`pair:${block.callId}`, [call, result], true, "tool pair", prompt, currentTurn, state));
			} else {
				paired.add(block.id);
				units.push(makeUnit(`malformed:${block.id}`, [block], false, "malformed tool pair kept full", prompt, currentTurn, state));
			}
			continue;
		}

		units.push(makeUnit(block.id, [block], true, "block", prompt, currentTurn, state));
	}
	return units;
}

function makeUnit(
	id: string,
	blocks: ContextBlock[],
	foldable: boolean,
	reason: string,
	_prompt: string,
	_currentTurn: number,
	_state: AccordionState,
): FoldUnit {
	const fullTokens = blocks.reduce((sum, block) => sum + block.tokens, 0);
	const foldedTokens = blocks.reduce((sum, block) => sum + digestTokens(block), 0);
	const unitTrimTokens = blocks.reduce((sum, block) => sum + trimTokens(block), 0);
	const unitTrimEligible = blocks.every((block) => trimEligible(block)) && unitTrimTokens < fullTokens;

	return {
		id,
		blocks,
		foldable,
		reason,
		score: 0,
		overlap: 0, // populated per foldable unit by Stage 2 (relById) in runConductor
		fullTokens,
		foldedTokens,
		trimTokens: unitTrimTokens,
		trimEligible: unitTrimEligible,
	};
}

function unitScore(unit: FoldUnit, prompt: string, weights: PromptWeights, currentTurn: number, state: AccordionState): FoldUnit {
	const weighted = unit.blocks.map((block) => {
		const kindScore = FOLD_RANK[block.kind] / 4;
		const overlap = relevance(block.text, prompt, state);
		const recency = currentTurn <= 1 ? 1 : block.turn / currentTurn;
		return kindScore * weights.kind + overlap * weights.keyword + recency * weights.recency;
	});
	return {
		...unit,
		score: weighted.reduce((sum, n) => sum + n, 0) / Math.max(1, weighted.length),
	};
}

/** Resolve the calibration-modulated stage-3 cutoffs. Higher calibrated target `c`
 *  (after corrections) slides the cutoffs DOWN so more units clear Full/Trim — i.e.
 *  the lens opens and we fold less. Quiet decay raises `c`'s effect in reverse. */
function desireCutoffs(c: number, band: FoldTargetBand, deps: ConductorDependencies): { full: number; trim: number } {
	const min = band.min ?? FOLD_TARGET_MIN;
	const max = band.max ?? FOLD_TARGET_MAX;
	const t = max > min ? Math.min(1, Math.max(0, (c - min) / (max - min))) : 0;
	const full = DESIRE_FULL_CUT_HI - t * (DESIRE_FULL_CUT_HI - DESIRE_FULL_CUT_LO);
	const trim = DESIRE_TRIM_CUT_HI - t * (DESIRE_TRIM_CUT_HI - DESIRE_TRIM_CUT_LO);
	const envFull = parseFloat(process?.env?.ACCORDION_DESIRE_FULL_CUT ?? "");
	const envTrim = parseFloat(process?.env?.ACCORDION_DESIRE_TRIM_CUT ?? "");
	return {
		full: deps.desireFullCut ?? (!isNaN(envFull) ? envFull : full),
		trim: deps.desireTrimCut ?? (!isNaN(envTrim) ? envTrim : trim),
	};
}

/**
 * Stage 3 of the desired-state pipeline: map a unit's relevance to a target fold
 * level, budget-blind. Relevance is the primary signal; `kind`/salience acts only as
 * a floor (risk-bearing units cannot be desired deeper than Trim). Hysteresis biases
 * the gating cutoffs toward the unit's prior level so borderline units stay put and
 * the Conductor does not fold/unfold the same block on consecutive turns.
 */
function desiredLevel(args: {
	prior: FoldLevel;
	rel: number;
	hasRisk: boolean;
	trimEligible: boolean;
	cutoffs: { full: number; trim: number };
	hysteresis: number;
}): FoldLevel {
	const { prior, rel, hasRisk, trimEligible: canTrim, cutoffs, hysteresis: h } = args;
	let fullCut = cutoffs.full;
	let trimCut = cutoffs.trim;
	// Sticky toward prior level: it takes a clear move PAST the cutoff to leave it.
	if (prior === 0) {
		fullCut -= h;
		trimCut -= h;
	} else if (prior === 1) {
		fullCut += h;
		trimCut -= h;
	} else {
		fullCut += h;
		trimCut += h;
	}
	let want: FoldLevel = rel >= fullCut ? 0 : rel >= trimCut ? 1 : 2;
	// kind/salience floor: a risk-bearing unit is never desired deeper than Trim.
	if (want > 1 && hasRisk) want = 1;
	// Trim is only worthwhile when the block is large enough to compress meaningfully.
	if (want === 1 && !canTrim) want = 2;
	return want;
}

function isPinned(block: ContextBlock, state: AccordionState): boolean {
	return state.pinnedBlockIds.includes(block.id) || state.pinnedTurnIndexes.includes(block.turn);
}

/**
 * True if the block belongs to a FOLDED group. While a group is folded the agent
 * sees the group's summary in place of all its members, so per-block fold decisions
 * for those members are meaningless — skip them in candidate selection so the
 * Conductor never double-folds something the group has already absorbed.
 */
function isInFoldedGroup(block: ContextBlock, state: AccordionState): boolean {
	for (const g of state.groups) {
		if (g.folded && g.memberIds.includes(block.id)) return true;
	}
	return false;
}

function isGraceProtected(block: ContextBlock, state: AccordionState, currentTurn: number): boolean {
	return state.manualChanges.some(
		(change) =>
			change.blockId === block.id &&
			(change.actor === "you" || change.actor === "agent") &&
			(change.action === "fold" || change.action === "unfold") &&
			change.turn === currentTurn,
	);
}

function protectedTailIds(blocks: ContextBlock[], maxTurn: number, workingTailTokens: number): Set<string> {
	const ids = new Set<string>();
	let sum = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block.turn === maxTurn) {
			ids.add(block.id);
			continue;
		}
		if (sum < workingTailTokens) {
			ids.add(block.id);
			sum += block.tokens;
		}
	}
	return ids;
}

export function contentHash(block: ContextBlock): string {
	const normalized = JSON.stringify({
		kind: block.kind,
		toolName: block.toolName ?? "",
		callId: block.callId ?? "",
		isError: !!block.isError,
		text: block.text.replace(/\s+/g, " ").trim(),
	});
	return createHash("sha256").update(normalized).digest("hex");
}

export function textHash(text: string): string {
	return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function pruneEmbeddingCache(
	state: AccordionState,
	blocks: ContextBlock[],
	prompt: string,
	maxEntries = MAX_EMBEDDING_CACHE_ENTRIES,
): void {
	const budget = Math.max(0, Math.floor(maxEntries));
	if (budget === 0) {
		state.embeddingCache = {};
		return;
	}

	const keys: string[] = [];
	const add = (text: string) => {
		if (!text.trim()) return;
		const key = textHash(text);
		if (!keys.includes(key)) keys.push(key);
	};
	add(prompt);
	// Retain block vectors newest-first, and the segment vectors of trim-eligible
	// blocks (query-aware extractive trim reads these). Keeping them aligned with
	// segmentForTrim avoids re-embedding the same segments every turn.
	for (let i = blocks.length - 1; i >= 0; i--) {
		add(blocks[i].text);
		if (blocks[i].tokens >= TRIM_MIN_TOKENS) for (const seg of segmentForTrim(blocks[i].text)) add(seg);
	}

	const keep = new Set(keys.slice(0, budget));
	state.embeddingCache = Object.fromEntries(
		Object.entries(state.embeddingCache).filter(([key]) => keep.has(key)),
	);

	// Rerank scores are query-specific; drop everything not keyed to the current prompt.
	const promptPrefix = `${textHash(prompt)}::`;
	state.rerankCache = Object.fromEntries(
		Object.entries(state.rerankCache ?? {}).filter(([key]) => key.startsWith(promptPrefix)),
	);

	// summaryCache is keyed by contentHash(block) — prune to the live block set so
	// it doesn't accumulate one entry per block ever summarized across the session.
	const summaryHashSet = new Set(blocks.map((b) => contentHash(b)));
	state.summaryCache = Object.fromEntries(
		Object.entries(state.summaryCache).filter(([k]) => summaryHashSet.has(k)),
	);
	state.pendingSummaryHashes = state.pendingSummaryHashes.filter((h) => summaryHashSet.has(h));
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Pre-warm the embedding cache for all block texts and the incoming prompt.
 *  Must be awaited BEFORE calling runConductor() to enable the semantic relevance path.
 *  runConductor() itself is synchronous — it only reads the cache. */
export async function warmEmbeddings(
	blocks: ContextBlock[],
	prompt: string,
	provider: EmbeddingProvider,
	state: AccordionState,
	timeoutMs = 2000,
): Promise<void> {
	const texts: string[] = [];
	const keys: string[] = [];
	const addIfMissing = (text: string) => {
		const key = textHash(text);
		if (!state.embeddingCache[key]) { texts.push(text); keys.push(key); }
	};
	addIfMissing(prompt);
	for (const block of blocks) addIfMissing(block.text);
	// Segment-level vectors for trim-eligible blocks enable query-aware extractive
	// trim (Phase 1). On cache miss the trim falls back to per-segment keyword overlap.
	for (const block of blocks) {
		if (block.tokens < TRIM_MIN_TOKENS) continue;
		for (const seg of segmentForTrim(block.text)) addIfMissing(seg);
	}
	if (texts.length === 0) return;

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
		});
		const vectors = await Promise.race([provider(texts), timeout]);
		for (let i = 0; i < keys.length; i++) state.embeddingCache[keys[i]] = vectors[i];
	} catch {
		// Non-throwing bounded timeout; relevance() falls back to keyword matching.
	} finally {
		// Clear the race timer on the success path so it doesn't dangle and pin the event loop.
		if (timer) clearTimeout(timer);
	}
}

function hasEmbeddings(state: AccordionState): boolean {
	return Object.keys(state.embeddingCache).length > 0;
}

function relevance(blockText: string, promptText: string, state: AccordionState): number {
	const bv = state.embeddingCache[textHash(blockText)];
	const pv = state.embeddingCache[textHash(promptText)];
	// Guard against a malformed/short provider return (mismatched dims would dot to NaN/garbage
	// and poison relevance). The rerank path already validates; this matches it for embeddings.
	if (bv && pv && bv.length === pv.length && bv.length > 0) {
		let dot = 0;
		for (let i = 0; i < bv.length; i++) dot += bv[i] * pv[i];
		return Number.isFinite(dot) ? dot : keywordOverlap(blockText, promptText); // L2-normalized → cosine
	}
	return keywordOverlap(blockText, promptText);
}

function rerankKey(query: string, candidate: string): string {
	return `${textHash(query)}::${textHash(candidate)}`;
}

/** Pre-warm the cross-encoder rerank cache for the unfold shortlist. Awaited BEFORE
 *  runConductor() (like warmEmbeddings). Bounded by a non-throwing timeout; on failure
 *  the unfold path falls back to the bi-encoder/keyword relevance score. */
export async function warmRerank(
	query: string,
	candidates: string[],
	provider: RerankProvider,
	state: AccordionState,
): Promise<void> {
	const pending: string[] = [];
	const seen = new Set<string>();
	for (const text of candidates) {
		const key = rerankKey(query, text);
		if (state.rerankCache[key] === undefined && !seen.has(text)) {
			seen.add(text);
			pending.push(text);
		}
	}
	if (pending.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timed out")), 2000);
		});
		const scores = await Promise.race([provider(query, pending), timeout]);
		for (let i = 0; i < pending.length; i++) {
			const score = scores[i];
			if (typeof score === "number" && Number.isFinite(score)) state.rerankCache[rerankKey(query, pending[i])] = score;
		}
	} catch {
		// Non-throwing: leave the cache as-is; unfold falls back to relevance().
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function rerankScore(query: string, candidate: string, state: AccordionState): number | undefined {
	return state.rerankCache?.[rerankKey(query, candidate)];
}

function summaryFor(block: ContextBlock, state: AccordionState, deps: ConductorDependencies): string {
	const digest = deterministicDigest(block);
	const hash = contentHash(block);
	const cached = state.summaryCache[hash];
	if (cached) return cached;

	if (!deps.summaryProvider) {
		if (!state.missingApiKeyLogged) {
			state.missingApiKeyLogged = true;
			deps.log?.("Accordion Conductor: ANTHROPIC_API_KEY missing; using deterministic digests.");
		}
		return digest;
	}

	if (!state.pendingSummaryHashes.includes(hash)) {
		state.pendingSummaryHashes.push(hash);
		void deps
			.summaryProvider({ block, hash, digest })
				.then((summary) => {
					const cleaned = summary.trim();
					if (!cleaned) return;
					state.summaryCache[hash] = cleaned;
					deps.onSummary?.(hash, cleaned);
				})
				.catch((error) => {
					deps.log?.(`Accordion Conductor: summary generation failed: ${String(error)}`);
				})
				.finally(() => {
					state.pendingSummaryHashes = state.pendingSummaryHashes.filter((h) => h !== hash);
				});
	}
	return digest;
}

// (removed in the accordion port) cloneMessages + applyFoldedContent — the original assembled the
// folded view by deep-cloning provider messages and rewriting block content in place. Accordion's
// host owns assembly: `computeFoldPlan` returns fold LEVELS and `commands.ts` turns them into
// content-substitution commands the host applies. No message mutation happens here anymore.

/** Input to the pure fold planner. Accordion's host already linearized the context into
 *  blocks and owns message assembly, so we operate on `ParsedContext` directly and never see
 *  raw provider messages — the key difference from the original `runConductor`. */
export interface FoldPlanInput {
	parsed: ParsedContext;
	incomingPrompt: string;
	budgetTokens: number;
	state: AccordionState;
	/** Blocks the host owns and we must never fold: protected tail ∪ human-held ∪ grouped. */
	offLimitsIds: Set<string>;
}

/** GroupMeta carries everything the command layer needs to emit one accordion `group` command:
 *  the contiguous run's member block ids plus the head's summary metadata. */
export interface GroupMeta {
	blockIds: string[];
	firstTurn: number;
	lastTurn: number;
	members: number;
	memberSalienceSuffix?: string;
}

/** The conductor's complete desired fold state for one pass — the pure result the command
 *  layer translates into `fold` / `replace` / `group` commands. */
export interface FoldPlan {
	/** Desired fold level per block id (absent ⇒ level 0, full). */
	levels: Map<string, FoldLevel>;
	/** Contiguous group runs keyed by head block id. */
	groups: Map<string, GroupMeta>;
	proactiveUnfolds: string[];
	foldTarget: number;
	assembledTokens: number;
	warnings: string[];
	decisions: FoldDecision[];
	unitTrace: FoldUnitTrace[];
}

/**
 * The faithful port of `runConductor`'s strategy core, decoupled from pi message I/O.
 * Stages 2–6 are byte-identical to the original; only the input adapter (parsed blocks +
 * host-supplied off-limits set instead of `parseMessages` + `protectedTailIds`) and the
 * output (a pure `FoldPlan` instead of rewritten messages) differ.
 */
export function computeFoldPlan(input: FoldPlanInput, deps: ConductorDependencies = {}): FoldPlan {
	const parsed = input.parsed;
	const warnings: string[] = [];
	const restingTarget = clampFoldTarget(
		input.state.foldTargetCalibrated ?? input.state.config.foldTargetInitial,
		foldTargetBand(input.state.config),
	);
	const emptyPlan = (foldTarget: number, assembledTokens: number): FoldPlan => ({
		levels: new Map(), groups: new Map(), proactiveUnfolds: [], foldTarget, assembledTokens,
		warnings, decisions: [], unitTrace: [],
	});
	if (parsed.turns.length === 0 || parsed.blocks.length === 0) {
		return emptyPlan(restingTarget, 0);
	}

	const currentTurn = parsed.turns[parsed.turns.length - 1].index;

	const known = new Set(parsed.blocks.map((block) => block.id));
	const levels = new Map<string, FoldLevel>();
	for (const id of input.state.foldedBlockIds) {
		if (!known.has(id)) continue;
		const depth = normalizeLevel(input.state.foldLevels?.[id] ?? 2);
		levels.set(id, depth > 0 ? depth : 2);
	}
	const initialLevels = new Map(levels);

	// The host owns the protected tail (and human-held / grouped blocks); it hands us the
	// off-limits set directly rather than us recomputing a token-walk tail.
	const protectedIds = input.offLimitsIds;
	const pinnedTokens = parsed.blocks
		.filter((block) => isPinned(block, input.state))
		.reduce((sum, block) => sum + block.tokens, 0);

	if (pinnedTokens > input.budgetTokens) {
		warnings.push(
			`Pinned blocks alone cost ~${pinnedTokens.toLocaleString()} tokens, above the ${input.budgetTokens.toLocaleString()} token budget.`,
		);
	}

	let live = liveTokensAtLevels(parsed.blocks, levels);
	if (live <= input.budgetTokens && levels.size === 0) {
		return emptyPlan(restingTarget, live);
	}

	// Stage 2 — Score. A pressure-active run ticks the calibrated fold target; the
	// target then modulates the stage-3 relevance cutoffs (higher target after
	// corrections → lower cutoffs → fold less). Relevance is the primary signal now,
	// not a blended kind/keyword/recency score.
	const foldTarget = calibrateFoldTarget(input.state, currentTurn, deps);
	const cutoffs = desireCutoffs(foldTarget, foldTargetBand(input.state.config), deps);
	const envHysteresis = parseFloat(process?.env?.ACCORDION_HYSTERESIS ?? "");
	const hysteresis = deps.hysteresisMargin ?? (!isNaN(envHysteresis) ? envHysteresis : HYSTERESIS_MARGIN);

	// Branch-aware low-signal floor: cosine path uses the semantic floor, keyword
	// fallback uses the stricter keyword threshold (preserves direct-probe behavior).
	let usingCosine = hasEmbeddings(input.state);
	if (usingCosine && !input.state.embeddingCache[textHash(input.incomingPrompt)]) usingCosine = false;
	if (!usingCosine && deps.embeddingProvider) {
		warnings.push("Embedding cache is missing the prompt vector. Relevance scoring degraded to keyword fallback.");
	}
	const rawFloor = parseFloat(process?.env?.ACCORDION_UNFOLD_FLOOR ?? "");
	const cosineFloor = deps.unfoldFloor ?? (!isNaN(rawFloor) ? rawFloor : LOW_SIGNAL_FLOOR);
	const lowSignalFloor = usingCosine ? cosineFloor : UNFOLD_KEYWORD_THRESHOLD;

	const units = buildFoldUnits(parsed.blocks, input.incomingPrompt, currentTurn, input.state);
	const canFoldUnit = (unit: FoldUnit) =>
		unit.foldable &&
		unit.foldedTokens < unit.fullTokens &&
		!unit.blocks.some(
			(block) =>
				isPinned(block, input.state) ||
				protectedIds.has(block.id) ||
				isGraceProtected(block, input.state, currentTurn) ||
				isInFoldedGroup(block, input.state),
		);
	const unitLevel = (unit: FoldUnit): FoldLevel =>
		unit.blocks.reduce((min: number, block) => Math.min(min, levels.get(block.id) ?? 0), 3) as FoldLevel;
	const setUnitLevel = (unit: FoldUnit, level: FoldLevel) => {
		for (const block of unit.blocks) {
			if (level === 0) levels.delete(block.id);
			else levels.set(block.id, level);
		}
	};
	const tokensAt = (unit: FoldUnit, level: FoldLevel) =>
		unit.blocks.reduce((sum, block) => sum + blockTokensAtLevel(block, level), 0);

	// Per-unit relevance = max over the unit's blocks. Two-stage relevance (Phase 2):
	// if every foldable candidate has a cross-encoder rerank score for this prompt,
	// score the whole shortlist with the reranker so comparisons stay in one [0,1]
	// space; otherwise fall back to bi-encoder/keyword for all (never mix spaces).
	const foldableUnits = units.filter((unit) => canFoldUnit(unit));
	const rerankReady =
		foldableUnits.length > 0 &&
		foldableUnits.every((unit) => unit.blocks.every((block) => rerankScore(input.incomingPrompt, block.text, input.state) !== undefined));
	const relOf = (unit: FoldUnit): number =>
		Math.max(
			...unit.blocks.map((block) =>
				rerankReady ? rerankScore(input.incomingPrompt, block.text, input.state)! : relevance(block.text, input.incomingPrompt, input.state),
			),
		);
	const relById = new Map(foldableUnits.map((unit) => [unit.id, relOf(unit)]));
	const maxRel = foldableUnits.length > 0 ? Math.max(...foldableUnits.map((unit) => relById.get(unit.id)!)) : 0;
	// Low-signal prompts (generic continuations, or no embeddings + zero keyword
	// overlap) carry no usable relevance: stage 3 holds prior levels and lets stage 4
	// drive folding under budget pressure alone.
	const lowSignal = isGenericContinuation(input.incomingPrompt) || maxRel < lowSignalFloor;

	// Risk-aware unfold: blocks whose digests carry high-signal markers (commands,
	// paths, exact_values, decisions) get a lower effective cutoff so they unfold on a
	// weaker relevance match — they're the ones most likely to cause a wrong answer if
	// left folded. Built over all units so buildDecisions can attribute the flags.
	const riskFlagsByBlockId = new Map<string, string[]>();
	for (const unit of foldableUnits) {
		for (const block of unit.blocks) {
			const flags = parseRiskFlags(deterministicDigest(block));
			if (flags.length > 0) riskFlagsByBlockId.set(block.id, flags);
		}
	}
	const unitRiskBonus = (unit: FoldUnit): number =>
		Math.max(0, ...unit.blocks.map((block) => riskFlagsByBlockId.get(block.id)?.length ?? 0));

	// Normalize: non-foldable units snap to full; mixed-level units snap to their
	// shallowest member, so tool pairs always move as one unit — the same
	// atomicity invariant the binary system enforced.
	for (const unit of units) {
		const blockLevels = unit.blocks.map((block) => levels.get(block.id) ?? 0);
		const hasFold = blockLevels.some((level) => level > 0);
		if (!canFoldUnit(unit)) {
			if (hasFold) setUnitLevel(unit, 0);
			continue;
		}
		const min = Math.min(...blockLevels) as FoldLevel;
		const max = Math.max(...blockLevels) as FoldLevel;
		if (min !== max) setUnitLevel(unit, min);
	}
	live = liveTokensAtLevels(parsed.blocks, levels);

	// Stage 3 — Desire (budget-blind). One pass sets every foldable unit to the level
	// its relevance wants, producing both folds (cold → deeper) and unfolds (relevant
	// → shallower) as a single diff vs the prior persisted levels. Low-signal prompts
	// hold prior so a routine "continue" turn never collapses the history.
	// thresholdById records the effective full-cutoff each foldable unit's relevance was
	// compared against, surfaced on the unitTrace for decision explainability.
	const thresholdById = new Map<string, number>();
	for (const unit of units) {
		if (!canFoldUnit(unit)) continue;
		const prior = unit.blocks.reduce<FoldLevel>((min, block) => Math.min(min, initialLevels.get(block.id) ?? 0) as FoldLevel, 3);
		if (lowSignal) {
			setUnitLevel(unit, prior);
			continue;
		}
		// Risk units unfold on a weaker match: lower their effective cutoffs.
		const riskBonus = unitRiskBonus(unit);
		const unitCutoffs =
			riskBonus > 0
				? {
						full: Math.max(RISK_FLOOR_MIN, cutoffs.full - riskBonus * RISK_FLOOR_BONUS),
						trim: Math.max(RISK_FLOOR_MIN, cutoffs.trim - riskBonus * RISK_FLOOR_BONUS),
					}
				: cutoffs;
		thresholdById.set(unit.id, unitCutoffs.full);
		const want = desiredLevel({
			prior,
			rel: relById.get(unit.id)!,
			hasRisk: riskBonus > 0,
			trimEligible: unit.trimEligible,
			cutoffs: unitCutoffs,
			hysteresis,
		});
		setUnitLevel(unit, want);
	}
	live = liveTokensAtLevels(parsed.blocks, levels);

	// Stage 4 — Reconcile (budget guard). Only acts when the desired state is over the
	// HARD budget. Escalate coldest-first (lowest relevance, older-first tiebreak):
	// trim-if-sufficient → digest, then the grouping passes below as deeper rungs.
	// budgetTokens is the only target now — calibration moved to the stage-3 cutoffs.
	if (live > input.budgetTokens) {
		const cold = units
			.filter((unit) => canFoldUnit(unit))
			.sort(
				(a, b) =>
					(relById.get(a.id)! - relById.get(b.id)!) ||
					a.blocks[0].turn - b.blocks[0].turn ||
					a.blocks[0].order - b.blocks[0].order,
			);
		for (const unit of cold) {
			if (live <= input.budgetTokens) break;
			const current = unitLevel(unit);
			if (current >= 2) continue;
			const currentTokens = tokensAt(unit, current);
			const need = live - input.budgetTokens;
			if (current < 1 && unit.trimEligible) {
				const trimSave = currentTokens - unit.trimTokens;
				if (trimSave >= need && trimSave > 0) {
					setUnitLevel(unit, 1);
					live -= trimSave;
					continue;
				}
			}
			const digestSave = currentTokens - tokensAt(unit, 2);
			if (digestSave <= 0) continue;
			setUnitLevel(unit, 2);
			live -= digestSave;
		}
	}

	// Deep pressure: contiguous runs of digested units collapse into a host-valid group.
	// V2 only emits runs that are already aligned to whole provider messages and balanced
	// across tool_call/tool_result pairs, so Accordion's outward snap will not change the run
	// and no straggler cost appears after application.
	const groupHeadMeta = new Map<string, GroupMeta>();
	const keyOf = (block: ContextBlock) => block.messageKey ?? block.id;

	/** Union salience markers from all member digests for enriched group head prefix. */
	const buildGroupMemberSalienceSuffix = (group: FoldUnit[]): string => {
		const cats = { paths: new Set<string>(), commands: new Set<string>(), errors: new Set<string>(), exact_values: new Set<string>(), decisions: new Set<string>() };
		for (const unit of group) {
			for (const block of unit.blocks) {
				const digest = deterministicDigest(block);
				const match = digest.match(/⟦([^⟧]+)⟧\s*$/);
				if (!match || /^(?:group|trim)\b/.test(match[1].trim())) continue;
				for (const part of match[1].split(/\s*∣\s*/)) {
					const colon = part.indexOf(":");
					if (colon < 0) continue;
					const key = part.slice(0, colon).trim() as keyof typeof cats;
					if (!(key in cats)) continue;
					for (const val of part.slice(colon + 1).split(/,\s*/)) {
						const t = val.trim();
						if (t && cats[key].size < 3) cats[key].add(t);
					}
				}
			}
		}
		const parts: string[] = [];
		if (cats.paths.size > 0) parts.push(`paths: ${[...cats.paths].join(", ")}`);
		if (cats.commands.size > 0) parts.push(`commands: ${[...cats.commands].join(", ")}`);
		if (cats.errors.size > 0) parts.push(`errors: ${[...cats.errors].join(", ")}`);
		if (cats.exact_values.size > 0) parts.push(`exact_values: ${[...cats.exact_values].join(", ")}`);
		if (cats.decisions.size > 0) parts.push(`decisions: ${[...cats.decisions].join(", ")}`);
		return parts.length > 0 ? ` ∣ ${parts.join(" ∣ ")}` : "";
	};
	const groupIds = (group: FoldUnit[]) => group.flatMap((unit) => unit.blocks.map((block) => block.id));
	const isWholeMessageAligned = (group: FoldUnit[]): boolean => {
		const ids = new Set(groupIds(group));
		const keys = new Set(group.flatMap((unit) => unit.blocks.map(keyOf)));
		for (const block of parsed.blocks) {
			if (keys.has(keyOf(block)) && !ids.has(block.id)) return false;
		}
		return true;
	};
	const isToolPairBalanced = (group: FoldUnit[]): boolean => {
		const ids = new Set(groupIds(group));
		const calls = new Map<string, ContextBlock>();
		const results = new Map<string, ContextBlock>();
		for (const block of parsed.blocks) {
			if (!block.callId) continue;
			if (block.kind === "tool_call") calls.set(block.callId, block);
			else if (block.kind === "tool_result") results.set(block.callId, block);
		}
		for (const block of group.flatMap((unit) => unit.blocks)) {
			if (!block.callId) continue;
			const partner = block.kind === "tool_call" ? results.get(block.callId) : calls.get(block.callId);
			if (partner && !ids.has(partner.id)) return false;
		}
		return true;
	};
	const estimatedGroupTokens = (group: FoldUnit[], meta: GroupMeta): number => {
		const head = group[0].blocks[0];
		const suffix = meta.memberSalienceSuffix ?? "";
		const groupId = `g:${meta.blockIds[0]}`;
		const summary = deterministicDigest(head);
		return tokensOf(`${foldTag(groupId)} \u27e6group \u00b7 turns ${meta.firstTurn}\u2013${meta.lastTurn} \u00b7 ${meta.members} units${suffix}\u27e7 ${summary}`);
	};

	if (live > input.budgetTokens) {
		const ordered = [...units].sort((a, b) => a.blocks[0].order - b.blocks[0].order);
		let run: FoldUnit[] = [];
		const flushRun = () => {
			if (run.length >= GROUP_MIN_UNITS && live > input.budgetTokens) {
				const head = run[0];
				const turns = run.flatMap((unit) => unit.blocks.map((block) => block.turn));
				const meta: GroupMeta = {
					blockIds: groupIds(run),
					firstTurn: Math.min(...turns),
					lastTurn: Math.max(...turns),
					members: run.length,
					memberSalienceSuffix: buildGroupMemberSalienceSuffix(run),
				};
				const before = run.reduce((sum, unit) => sum + tokensAt(unit, unitLevel(unit)), 0);
				const groupTokens = estimatedGroupTokens(run, meta);
				if (isWholeMessageAligned(run) && isToolPairBalanced(run) && groupTokens < before) {
					for (const member of run) setUnitLevel(member, 3);
					live += groupTokens - before;
					groupHeadMeta.set(head.blocks[0].id, meta);
				}
			}
			run = [];
		};
		for (const unit of ordered) {
			if (live <= input.budgetTokens) break;
			if (canFoldUnit(unit) && unitLevel(unit) === 2) run.push(unit);
			else flushRun();
		}
		flushRun();
	}

	// NOTE (accordion port): the_conductor's second, SEMANTIC grouping pass — clustering
	// NON-adjacent L2 blocks by digest-text overlap — is intentionally CUT here. Accordion's
	// `group` command requires a CONTIGUOUS run (the host snaps it outward to whole messages),
	// so a non-adjacent cluster cannot be expressed as one command. Those blocks simply stay at
	// L2 digest; the contiguous pass above is the only grouping the contract can carry.

	// Stage 6 — Emit. proactiveUnfolds are the relevance-driven unfolds: any block whose
	// assembled level ended SHALLOWER than its prior persisted level. Stage 3 produced
	// these directly (relevance pulled them up), so there is no separate rescue pass.
	const proactiveUnfolds: string[] = [];
	for (const block of parsed.blocks) {
		const before = initialLevels.get(block.id) ?? 0;
		const after = levels.get(block.id) ?? 0;
		if (after < before) proactiveUnfolds.push(block.id);
	}
	const proactiveUnfoldSet = new Set(proactiveUnfolds);

	// Unfolds are correction evidence for the calibrator: the Conductor had folded
	// something the conversation turned out to need. This opens the lens next turn.
	if (proactiveUnfolds.length > 0) {
		const turns = new Set(input.state.recentProactiveUnfoldTurns);
		turns.add(currentTurn);
		input.state.recentProactiveUnfoldTurns = [...turns]
			.filter((turn) => currentTurn - turn <= UNFOLD_FEEDBACK_TURNS * 2)
			.sort((a, b) => a - b);
	}

	const decisions = buildDecisions(parsed.blocks, initialLevels, levels, input.incomingPrompt, input.state, {
		currentTurn,
		proactiveUnfoldIds: proactiveUnfoldSet,
		riskFlagsByBlockId,
	});

	// NOTE (accordion port): message assembly + the agent-facing context-awareness header
	// (fact ledger / relevance TOC injection) are CUT here. Accordion's host owns message
	// assembly, and the command vocabulary can only edit EXISTING blocks — there is no insert
	// primitive for a synthetic header block. The header's main job (teaching the agent that
	// folds are recoverable) is already served by the host's `{#code FOLDED}` tags + recall/
	// unfold tools. The fact-ledger / TOC are surfaced to the HUMAN via `conductor/status`
	// instead (computed in the server from the exported buildFactLedger / buildRelevanceTOC).

	input.state.lastRunHadPressure = true;
	input.state.lastRunWithinBudget = live <= input.budgetTokens;

	// Per-unit trace for the conductor dashboard. The unit aggregates a single
	// block or a tool_call/tool_result pair; level/fromLevel are taken from the
	// pair's shallowest member to match the conductor's atomic-unit invariant.
	const unitTrace: FoldUnitTrace[] = units.map((unit) => {
		const avgKind =
			unit.blocks.reduce((sum, block) => sum + FOLD_RANK[block.kind] / 4, 0) / Math.max(1, unit.blocks.length);
		const avgRecency =
			unit.blocks.reduce(
				(sum, block) => sum + (currentTurn <= 1 ? 1 : block.turn / currentTurn),
				0,
			) / Math.max(1, unit.blocks.length);
		const fromLevel = unit.blocks.reduce<FoldLevel>(
			(min, block) => Math.min(min, initialLevels.get(block.id) ?? 0) as FoldLevel,
			3,
		);
		const level = unit.blocks.reduce<FoldLevel>(
			(min, block) => Math.min(min, levels.get(block.id) ?? 0) as FoldLevel,
			3,
		);
		const eligible = canFoldUnit(unit);
		// Stage attribution: rerank is all-or-nothing across the foldable shortlist; the
		// bi-encoder needs both the prompt vector and a block vector cached, else keyword.
		const promptCached = !!input.state.embeddingCache[textHash(input.incomingPrompt)];
		const stage: 1 | 2 | 3 | undefined = !eligible
			? undefined
			: rerankReady
				? 3
				: promptCached && unit.blocks.some((block) => input.state.embeddingCache[textHash(block.text)])
					? 2
					: 1;
		return {
			id: unit.id,
			blockIds: unit.blocks.map((block) => block.id),
			foldable: unit.foldable,
			reason: unit.reason,
			kindWeight: avgKind,
			overlap: relById.get(unit.id) ?? unit.overlap,
			recency: avgRecency,
			score: relById.get(unit.id) ?? unit.score,
			fullTokens: unit.fullTokens,
			foldedTokens: unit.foldedTokens,
			trimTokens: unit.trimTokens,
			trimEligible: unit.trimEligible,
			level,
			fromLevel,
			eligible,
			stage,
			threshold: thresholdById.get(unit.id),
		};
	});

	return {
		levels,
		groups: groupHeadMeta,
		decisions,
		warnings,
		proactiveUnfolds,
		foldTarget,
		assembledTokens: live,
		unitTrace,
	};
}

export function contentForLevel(
	block: ContextBlock,
	level: FoldLevel,
	state: AccordionState,
	deps: ConductorDependencies,
	groupMeta?: { blockIds: string[]; firstTurn: number; lastTurn: number; members: number; memberSalienceSuffix?: string },
	prompt?: string,
): string {
	if (level === 1) return foldAddress(block) + trimmedText(block, prompt, state);
	if (level === 3) return groupMemberText(block);
	const summary = summaryFor(block, state, deps);
	if (groupMeta) {
		const suffix = groupMeta.memberSalienceSuffix ?? "";
		const groupId = `g:${groupMeta.blockIds[0]}`;
		return `${foldTag(groupId)} \u27e6group \u00b7 turns ${groupMeta.firstTurn}\u2013${groupMeta.lastTurn} \u00b7 ${groupMeta.members} units${suffix}\u27e7 ${summary}`;
	}
	return foldAddress(block) + summary;
}

function buildDecisions(
	blocks: ContextBlock[],
	initialLevels: Map<string, FoldLevel>,
	finalLevels: Map<string, FoldLevel>,
	prompt: string,
	state: AccordionState,
	meta: {
		currentTurn?: number;
		proactiveUnfoldIds?: Set<string>;
		riskFlagsByBlockId?: Map<string, string[]>;
	} = {},
): FoldDecision[] {
	const { currentTurn = 0, proactiveUnfoldIds = new Set(), riskFlagsByBlockId = new Map() } = meta;
	const decisions: FoldDecision[] = [];
	for (const block of blocks) {
		const fromLevel = (initialLevels.get(block.id) ?? 0) as FoldLevel;
		const level = (finalLevels.get(block.id) ?? 0) as FoldLevel;
		if (fromLevel === level) continue;
		const overlap = relevance(block.text, prompt, state);
		const deeper = level > fromLevel;
		const reasons: string[] = [];
		if (!deeper) {
			reasons.push(level === 0 ? "relevance_high" : "relevance_eased");
			if (proactiveUnfoldIds.has(block.id)) reasons.push("proactive_rescue");
			const riskFlags = riskFlagsByBlockId.get(block.id) ?? [];
			for (const flag of riskFlags) reasons.push(`digest_has_risk_flag:${flag}`);
			if (riskFlags.length > 0) reasons.push("expected_answer_improvement_high");
		} else if (level === 1) {
			reasons.push(overlap < 0.2 ? "relevance_low" : "budget_pressure");
			reasons.push("trim_sufficient");
		} else if (level === 3) {
			reasons.push("budget_pressure_deep");
			reasons.push("grouped");
		} else {
			reasons.push(overlap < 0.2 ? "relevance_low" : "budget_pressure");
			if (block.tokens > 500) reasons.push("token_cost_high");
			if (currentTurn > 1 && block.turn / currentTurn < 0.5) reasons.push("age_high");
			reasons.push("not_pinned");
		}
		decisions.push({
			blockId: block.id,
			action: deeper ? "fold" : "unfold",
			actor: "conductor",
			reason: reasons,
			turn: block.turn,
			kind: block.kind,
			callId: block.callId,
			level,
			fromLevel,
		});
	}
	return decisions;
}

export function applyDecisionsToState(state: AccordionState, decisions: FoldDecision[]): void {
	for (const decision of decisions) {
		if (decision.action === "pin") {
			state.conductorPins ??= {};
			const reason = Array.isArray(decision.reason) ? (decision.reason[0] ?? "conductor_pin") : decision.reason;
			state.conductorPins[decision.blockId] = { turn: decision.turn, reason };
			continue;
		}
		const fallback: FoldLevel = decision.action === "fold" ? 2 : 0;
		const normalized = normalizeLevel(decision.level ?? fallback);
		const level: FoldLevel = decision.action === "fold" && normalized === 0 ? 2 : normalized;
		if (level === 0) delete state.foldLevels[decision.blockId];
		else state.foldLevels[decision.blockId] = level;
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(
		...decisions
			.filter((d) => d.action !== "pin")
			.map((decision) => ({
				blockId: decision.blockId,
				action: decision.action as "fold" | "unfold",
				actor: decision.actor,
				turn: decision.turn,
			})),
	);
	state.manualChanges = state.manualChanges.slice(-1000);
}

export function extractIncomingPrompt(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as any).role === "user") return getText((messages[i] as any).content);
	}
	return "";
}

export function lastCompletedTurnFromMessages(messages: AgentMessage[]): LastCompletedTurn | null {
	const parsed = parseMessages(messages);
	if (parsed.turns.length === 0) return null;
	const turn = parsed.turns[parsed.turns.length - 1];
	return {
		index: turn.index,
		messages: turn.messageIndexes.map((i) => messages[i]),
		tokens: turn.tokens,
	};
}

export function createHaikuSummaryProvider(
	apiKey = process?.env?.ANTHROPIC_API_KEY,
	model = SUMMARY_MODEL,
	timeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS,
) {
	if (!apiKey) return undefined;
	return async ({ block, digest }: SummaryRequest): Promise<string> => {
		// Bound the request: a hung fetch would otherwise never clear its hash from
		// pendingSummaryHashes, so that block could never be re-summarized. (The OpenAI-compatible
		// provider already does this; the default Haiku path must too.)
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model,
					max_tokens: 180,
					messages: [
						{
							role: "user",
							content: summaryPrompt(block, digest),
						},
					],
				}),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`Anthropic ${response.status}`);
			const json = (await response.json()) as any;
			return getText(json.content) || digest;
		} finally {
			clearTimeout(timer);
		}
	};
}

export function createOpenAICompatibleSummaryProvider(
	options: OpenAICompatibleSummaryProviderOptions,
): SummaryProvider {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
	const baseUrl = options.baseUrl.replace(/\/$/, "");
	return async ({ block, digest }: SummaryRequest): Promise<string> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error(`summary timed out after ${timeoutMs}ms`)), timeoutMs);
		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"content-type": "application/json",
					...(options.headers ?? {}),
				},
				body: JSON.stringify({
					model: options.model,
					temperature: 0.1,
					max_tokens: 180,
					stream: false,
					messages: [
						{
							role: "system",
							content:
								"You summarize folded Accordion context blocks. Return only the summary, with no preamble.",
						},
						{
							role: "user",
							content: summaryPrompt(block, digest),
						},
					],
				}),
			});
			if (!response.ok) throw new Error(`OpenAI-compatible summary ${response.status}`);
			const json = (await response.json()) as any;
			const summary = json?.choices?.[0]?.message?.content;
			if (typeof summary !== "string" || !summary.trim()) return digest;
			return summary.trim();
		} finally {
			clearTimeout(timeout);
		}
	};
}

function ollamaOpenAIBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/$/, "");
	return /\/v\d+(?:\/|$)/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function createOllamaSummaryProvider(options: OllamaSummaryProviderOptions = {}): SummaryProvider {
	return createOpenAICompatibleSummaryProvider({
		baseUrl: ollamaOpenAIBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL),
		model: options.model ?? DEFAULT_OLLAMA_MODEL,
		timeoutMs: options.timeoutMs,
	});
}

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

export function createGeminiSummaryProvider(
	apiKey = process?.env?.GOOGLE_API_KEY,
	model = DEFAULT_GEMINI_MODEL,
): SummaryProvider | undefined {
	if (!apiKey) return undefined;
	return createOpenAICompatibleSummaryProvider({
		baseUrl: DEFAULT_GEMINI_BASE_URL,
		model,
		headers: { Authorization: `Bearer ${apiKey}` },
	});
}

/** Local embedding provider using @huggingface/transformers (feature-extraction pipeline).
 *  Default model: Xenova/all-MiniLM-L6-v2 — 384d, 256-token input cap, no prefix needed.
 *  Upgrade: "nomic-ai/nomic-embed-text-v1.5" (768d, 8k ctx) but requires
 *  "search_document:" / "search_query:" prefixes on inputs.
 *  Pipeline is lazy-loaded on first call and reused across subsequent calls. */
export async function createTransformersEmbeddingProvider(model = EMBEDDING_MODEL): Promise<EmbeddingProvider> {
	let pipelineFactory: any;
	try {
		const { pipeline } = await import("@huggingface/transformers");
		pipelineFactory = pipeline;
	} catch (err: any) {
		if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find package")) {
			throw new Error("install @huggingface/transformers to enable --embeddings, or run without it");
		}
		throw err;
	}

	const needsPrefix = model.includes("nomic-embed-text");
	let pipePromise: Promise<any> | null = null;
	return async (texts: string[]) => {
		pipePromise ??= pipelineFactory("feature-extraction", model);
		const pipe = await pipePromise;
		const results: number[][] = [];
		for (const text of texts) {
			const prepared = needsPrefix ? `search_document: ${text}` : text;
			const out = await pipe(prepared, { pooling: "mean", normalize: true });
			results.push(Array.from(out.data as Float32Array));
		}
		return results;
	};
}

export const RERANK_MODEL = process?.env?.ACCORDION_RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";

/** Cross-encoder rerank provider (Phase 2, two-stage relevance). Scores each
 *  [query, candidate] pair with a sequence-classification head and sigmoid-normalizes
 *  the logit to [0,1]. Lazy-loaded and reused like the embedding provider; if
 *  @huggingface/transformers is absent it throws a clear error and the conductor
 *  falls back to bi-encoder/keyword relevance. NOTE: the exact transformers.js cross-
 *  encoder surface should be validated against the installed version before relying on
 *  it in production; the conductor degrades gracefully if scores never arrive. */
export async function createTransformersRerankProvider(model = RERANK_MODEL): Promise<RerankProvider> {
	let factory: any;
	try {
		const transformers = await import("@huggingface/transformers");
		factory = transformers;
	} catch (err: any) {
		if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find package")) {
			throw new Error("install @huggingface/transformers to enable reranking, or run without it");
		}
		throw err;
	}

	const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
	let modelPromise: Promise<{ tokenizer: any; model: any }> | null = null;
	const load = async () => {
		const { AutoTokenizer, AutoModelForSequenceClassification } = factory;
		const [tokenizer, mdl] = await Promise.all([
			AutoTokenizer.from_pretrained(model),
			AutoModelForSequenceClassification.from_pretrained(model),
		]);
		return { tokenizer, model: mdl };
	};

	return async (query: string, candidates: string[]) => {
		modelPromise ??= load();
		const { tokenizer, model: mdl } = await modelPromise;
		const scores: number[] = [];
		for (const candidate of candidates) {
			const inputs = tokenizer(query, { text_pair: candidate, truncation: true });
			const { logits } = await mdl(inputs);
			const data = Array.from(logits.data as Float32Array) as number[];
			scores.push(sigmoid(data[data.length - 1] ?? data[0] ?? 0));
		}
		return scores;
	};
}

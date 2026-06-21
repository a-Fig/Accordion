import type {
	ConductorCacheSnapshot,
	ConductorCalibrationEvent,
	ConductorDiagnostics,
	ConductorFactLedgerEntry,
	ConductorFoldUnitTrace,
	ConductorHealthSnapshot,
	ConductorProactiveUnfold,
	ConductorRelevanceTOCEntry,
	JSONValue,
} from "$conductors/contract";
import type { DecisionEvent } from "$lib/engine/store.svelte";

export interface NeededStats {
	needed: number;
	harmless: number;
	pending: number;
	resolved: number;
	neededRate: number | null;
}

export interface HealthVerdict {
	level: "green" | "yellow" | "red";
	foldCoverage: number | null;
	withinBudget: boolean;
	neededRate: number | null;
}

function obj(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

export function pressureLabel(assembled: number, budget: number): "comfortable" | "normal" | "tight" {
	const ratio = budget > 0 ? assembled / budget : 0;
	if (ratio < 0.7) return "comfortable";
	if (ratio < 0.85) return "normal";
	return "tight";
}

export function formatTokens(n: number | undefined | null): string {
	if (n == null || !Number.isFinite(n)) return "n/a";
	const r = Math.round(n);
	if (r >= 1_000_000) {
		const m = r / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
	}
	return r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `${r}`;
}

export function formatCount(n: number | undefined | null): string {
	return n == null || !Number.isFinite(n) ? "n/a" : Math.round(n).toLocaleString();
}

export function normalizeDiagnostics(details: JSONValue | undefined): ConductorDiagnostics {
	const root = obj(details);
	if (!root) return {};

	const health = obj(root.health);
	const caches = obj(root.caches);
	const legacySummary = obj(root.summary);

	const out: ConductorDiagnostics = {};
	if (health) {
		const band = obj(health.foldTargetBand);
		out.health = {
			foldTargetCalibrated: num(health.foldTargetCalibrated),
			foldTargetThisTurn: num(health.foldTargetThisTurn),
			foldTargetBand:
				band && num(band.min) !== undefined && num(band.max) !== undefined
					? { min: num(band.min)!, max: num(band.max)! }
					: undefined,
			assembledTokens: num(health.assembledTokens),
			budgetTokens: num(health.budgetTokens),
			contextWindow: health.contextWindow === null ? null : num(health.contextWindow),
			pressure: str(health.pressure),
		};
	}

	const unitTrace = arr(root.unitTrace)
		.map((item): ConductorFoldUnitTrace | null => {
			const row = obj(item);
			if (!row || !str(row.id)) return null;
			return {
				id: str(row.id)!,
				blockIds: arr(row.blockIds).filter((x): x is string => typeof x === "string"),
				kindWeight: num(row.kindWeight),
				overlap: num(row.overlap),
				recency: num(row.recency),
				score: num(row.score),
				stage: typeof row.stage === "number" || typeof row.stage === "string" ? row.stage as ConductorFoldUnitTrace["stage"] : undefined,
				threshold: num(row.threshold),
				fullTokens: num(row.fullTokens),
				foldedTokens: num(row.foldedTokens),
				trimTokens: num(row.trimTokens),
				trimEligible: typeof row.trimEligible === "boolean" ? row.trimEligible : undefined,
				level: num(row.level) as ConductorFoldUnitTrace["level"],
				fromLevel: num(row.fromLevel) as ConductorFoldUnitTrace["fromLevel"],
				eligible: typeof row.eligible === "boolean" ? row.eligible : undefined,
				reason: str(row.reason),
			};
		})
		.filter((x): x is ConductorFoldUnitTrace => !!x);
	if (unitTrace.length) out.unitTrace = unitTrace;

	const factLedger: ConductorFactLedgerEntry[] = [];
	for (const item of arr(root.factLedger)) {
		const row = obj(item);
		if (!row) continue;
		const category = str(row.category) ?? str(row.cat);
		const value = str(row.value) ?? str(row.label);
		if (!category || !value) continue;
		factLedger.push({ category, value, turn: num(row.turn), sourceId: str(row.sourceId) });
	}
	if (factLedger.length) out.factLedger = factLedger;

	const relevanceTOC: ConductorRelevanceTOCEntry[] = [];
	for (const item of arr(root.relevanceTOC)) {
		const row = obj(item);
		const turn = row ? num(row.turn) : undefined;
		if (!row || turn === undefined) continue;
		relevanceTOC.push({
			turn,
			score: num(row.score),
			label: str(row.label) ?? "",
			blockIds: arr(row.blockIds).filter((x): x is string => typeof x === "string"),
		});
	}
	if (relevanceTOC.length) out.relevanceTOC = relevanceTOC;

	const proactiveUnfolds: ConductorProactiveUnfold[] = [];
	for (const item of arr(root.proactiveUnfolds)) {
		if (typeof item === "string") {
			proactiveUnfolds.push({ blockId: item });
			continue;
		}
		const row = obj(item);
		if (!row) continue;
		proactiveUnfolds.push({
			id: str(row.id),
			blockId: str(row.blockId),
			blockIds: arr(row.blockIds).filter((x): x is string => typeof x === "string"),
			turn: num(row.turn),
			reason: str(row.reason),
		});
	}
	if (proactiveUnfolds.length) out.proactiveUnfolds = proactiveUnfolds;

	const calibration = obj(root.calibration);
	if (calibration) {
		const events: ConductorCalibrationEvent[] = [];
		for (const item of arr(calibration.events)) {
			const row = obj(item);
			const turn = row ? num(row.turn) : undefined;
			const from = row ? num(row.from) : undefined;
			const to = row ? num(row.to) : undefined;
			if (!row || turn === undefined || from === undefined || to === undefined) continue;
			events.push({
				turn,
				from,
				to,
				corrections: num(row.corrections),
				reason: str(row.reason) ?? "hold",
			});
		}
		out.calibration = {
			needed: num(calibration.needed),
			harmless: num(calibration.harmless),
			neededRate: num(calibration.neededRate),
			events,
		};
	}

	const cacheSnapshot: ConductorCacheSnapshot = {};
	if (caches) {
		cacheSnapshot.summary = normalizeCache(caches.summary);
		cacheSnapshot.embedding = normalizeCache(caches.embedding);
		cacheSnapshot.rerank = normalizeCache(caches.rerank);
		cacheSnapshot.latestProviderError = str(caches.latestProviderError);
	} else if (legacySummary) {
		cacheSnapshot.summary = normalizeCache(legacySummary);
	}
	if (cacheSnapshot.summary || cacheSnapshot.embedding || cacheSnapshot.rerank || cacheSnapshot.latestProviderError) {
		out.caches = cacheSnapshot;
	}

	return out;
}

function normalizeCache(value: unknown): NonNullable<ConductorCacheSnapshot["summary"]> | undefined {
	const row = obj(value);
	if (!row) return undefined;
	return {
		size: num(row.size) ?? num(row.cached),
		pending: num(row.pending),
		provider: str(row.provider),
		calls: num(row.calls),
		errors: num(row.errors),
		latestError: str(row.latestError) ?? str(row.lastError),
	};
}

export function healthFromStore(
	health: ConductorHealthSnapshot | undefined,
	liveTokens: number,
	budget: number,
	contextWindow: number | null,
): ConductorHealthSnapshot {
	const assembled = health?.assembledTokens ?? liveTokens;
	const budgetCap = contextWindow && contextWindow > 0 ? Math.min(budget, contextWindow) : budget;
	const budgetTokens = health?.budgetTokens ?? budgetCap;
	return {
		...health,
		assembledTokens: assembled,
		budgetTokens,
		contextWindow: health?.contextWindow ?? contextWindow,
		pressure: health?.pressure ?? pressureLabel(assembled, budgetTokens),
	};
}

interface Attempt {
	turn?: number;
}

function blockKeys(ids: readonly string[]): string[] {
	return ids.filter((id) => id && !id.startsWith("g:")).map((id) => `b:${id}`);
}

function groupKey(ids: readonly string[]): string | null {
	const id = ids.find((x) => x?.startsWith("g:"));
	return id ?? null;
}

export function computeNeededStats(events: readonly DecisionEvent[], currentTurn?: number): NeededStats {
	const active = new Map<string, Attempt>();
	let needed = 0;
	let harmless = 0;

	const start = (key: string, turn?: number) => {
		if (!active.has(key)) active.set(key, { turn });
	};
	const close = (key: string, status: "needed" | "harmless") => {
		if (!active.has(key)) return;
		active.delete(key);
		if (status === "needed") needed++;
		else harmless++;
	};

	for (const ev of [...events].reverse()) {
		if (ev.by === "auto" && (ev.action === "fold" || ev.action === "replace")) {
			for (const key of blockKeys(ev.ids)) start(key, ev.turn);
			continue;
		}
		if (ev.by === "auto" && ev.action === "group") {
			const key = groupKey(ev.ids);
			if (key) start(key, ev.turn);
			continue;
		}
		if (ev.by === "auto" && ev.action === "restore") {
			for (const key of blockKeys(ev.ids)) close(key, "harmless");
			continue;
		}
		if (ev.by === "auto" && ev.action === "ungroup") {
			const key = groupKey(ev.ids);
			if (key) close(key, "harmless");
			continue;
		}
		if (ev.by !== "auto" && (ev.action === "unfold" || ev.action === "restore")) {
			for (const key of blockKeys(ev.ids)) close(key, "needed");
			continue;
		}
		if (ev.by !== "auto" && (ev.action === "ungroup" || ev.action === "unfold-group")) {
			const key = groupKey(ev.ids);
			if (key) close(key, "needed");
		}
	}
	let pending = 0;
	for (const attempt of active.values()) {
		if (currentTurn !== undefined && attempt.turn !== undefined && attempt.turn < currentTurn) harmless++;
		else pending++;
	}
	const resolved = needed + harmless;
	return { needed, harmless, pending, resolved, neededRate: resolved > 0 ? needed / resolved : null };
}

export function computeHealthVerdict(
	unitTrace: readonly ConductorFoldUnitTrace[],
	health: ConductorHealthSnapshot,
	needed: NeededStats,
): HealthVerdict {
	let eligibleMass = 0;
	let foldedMass = 0;
	for (const unit of unitTrace) {
		if (!unit.eligible) continue;
		const full = unit.fullTokens ?? 0;
		eligibleMass += full;
		if ((unit.level ?? 0) > 0) foldedMass += full;
	}
	const foldCoverage = eligibleMass > 0 ? foldedMass / eligibleMass : null;
	const withinBudget = (health.assembledTokens ?? 0) <= (health.budgetTokens ?? Number.POSITIVE_INFINITY);
	if (!withinBudget || (foldCoverage !== null && foldCoverage < 0.5 && health.pressure === "tight")) {
		return { level: "red", foldCoverage, withinBudget, neededRate: needed.neededRate };
	}
	if (needed.neededRate !== null && needed.neededRate > 0.5) {
		return { level: "yellow", foldCoverage, withinBudget, neededRate: needed.neededRate };
	}
	return { level: "green", foldCoverage, withinBudget, neededRate: needed.neededRate };
}

export function levelName(level: number | undefined): string {
	if (level === 1) return "trim";
	if (level === 2) return "digest";
	if (level === 3) return "group";
	return "full";
}

export function stageName(stage: ConductorFoldUnitTrace["stage"]): string {
	if (stage === 2 || stage === "embed") return "embed";
	if (stage === 3 || stage === "rerank") return "rerank";
	if (stage === 1 || stage === "keyword") return "keyword";
	return "";
}

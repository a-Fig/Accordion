// thermocline.ts — the Thermocline epoch machine as a conductor-v2 `Conductor`.
//
// Ported from the pre-excision WebSocket server `thermocline.mjs` (commit dc037bc) and rewritten
// against the RAW evented `ConductorHost` contract (core/conductor/contract.ts) instead of the old
// `context/update` / `conductor/commands` / `cap/request` WebSocket protocol. The whole point of
// the owner's "out of process" decision is that the conductor class is written ONLY against
// `ConductorHost`: in Phase C a remote SDK will mirror truth into a local `ConductorHost` inside a
// separate Node process (see runner.mjs), and the SAME class runs there unchanged. Because it is
// written against `ConductorHost`, it is ALSO fully unit-testable in-process against TestHost today.
//
// The double-buffered epoch lifecycle (ADR 0015 §3), mapped onto the new contract:
//
//   HOLD      — below warmWater. `holdOrResend` re-derives the desired ops from the committed plan
//               against the current view and proposes only the DELTA (signature-dedup: an unchanged
//               desired state produces an empty transaction). No LLM.
//   PREPARE   — crossing warmWater: `prepareEpoch` plans the next target and fires every L2/L3
//               `host.complete` in PARALLEL off to the side. A `prepareToken` generation guard
//               discards a superseded prepare (a newer prepare, an emergency, an agent unfold).
//   COMMIT    — atomic: reconcile against agent touches during prepare (reconcilePlan), substitute
//               REAL summary token counts, top up deterministically to ≤ cap, and propose ONE
//               transaction against the host.
//   EMERGENCY — over the hard cap → a DETERMINISTIC plan (no LLM), proposed immediately.
//
// locks: ["human-steering"] ONLY. `agent-unfold` stays UNLOCKED on purpose — the agent's unfold IS
// graduation gate ②. `recall` is never lockable (ADR 0011 floor).
//
// wire-departing: we declare a SMALL `holdWireUpToMs` and use the pre-model-call `wire-departing`
// event as the last-line HARD-CAP guarantee, running the SAME deterministic emergency synchronously
// (no LLM, no async, no inline disk I/O — persistence is deferred off every hook path). The
// expensive PREPARE/LLM machinery runs on `turn-committed`, never inside the hold window.
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	Conductor,
	ConductorHost,
	HostEvent,
	StateChange,
	ViewBlock,
	LockName,
	Op,
} from "../../core/conductor/contract";
import type { ConductorView } from "../../core/conductor/view";
import type { Config, Plan, ThermoState, Applied, Unit } from "./policy";
import {
	DEFAULT_CFG,
	buildUnits,
	project,
	updateGraduation,
	planEpoch,
	capOf,
	foldBody,
	foldableMemberIds,
	stratumSummary,
	buildDigestPrompt,
	buildStratumPrompt,
	unionSet,
} from "./policy";
import { scoreCandidates, tailTextFromView, type Scorer } from "./scorer";

const ID = "thermocline";
const LABEL = "Thermocline";

/** A stratum the conductor has actually committed to the engine (tracks its live group id). */
interface AppliedStratum {
	firstId: string;
	lastId: string;
	unitIds: string[];
	memberIds: string[];
	/** The full tagged summary string on the wire (or null for a drop). */
	summary: string | null;
	summaryTokens: number;
	/** The engine group id (`g:<firstMember>`); needed to `ungroup` it later. */
	groupId: string | null;
}

/** The desired next state a plan renders — the diff target for `applyDesired`. */
interface Desired {
	/** id → bare (untagged) fold body. */
	folds: Map<string, string>;
	strata: {
		firstId: string;
		lastId: string;
		unitIds: string[];
		memberIds: string[];
		summary: string | null;
		summaryTokens: number;
	}[];
}

/** The on-disk persisted shape (deep zone + graduation). */
interface PersistedState {
	strata: AppliedStratum[];
	dwell: [string, number][];
	everWarm: string[];
}

export interface ThermoclineOptions {
	/** Override any policy tuning constant. */
	cfg?: Partial<Config>;
	/** Injected temperature scorer. Default: the real Python attention probe. Tests pass a fake. */
	scorer?: Scorer;
	/** Directory for `thermocline-state-<sessionKey>.json`. Default `~/.accordion/conductors`. Tests
	 *  pass a temp dir so the real `~/.accordion` is never touched. */
	persistDir?: string;
	/** Session identity for the persist filename. `null`/undefined ⇒ persistence disabled. In Phase C
	 *  the runner supplies this from the session; the class never derives it from the host. */
	sessionKey?: string | null;
}

/** Persist filename for a session key. */
function persistPath(dir: string, key: string): string {
	return join(dir, `thermocline-state-${key}.json`);
}

export class ThermoclineConductor implements Conductor {
	readonly id = ID;
	readonly label = LABEL;
	readonly description = "Attention-gated LLM compression in deliberate epochs, under a hard budget invariant.";
	// human-steering ONLY — agent-unfold stays open (the agent's unfold is graduation gate ②).
	readonly locks: readonly LockName[] = ["human-steering"];
	// Small hold: the pre-model-call wire-departing hook runs a strictly deterministic emergency.
	readonly holdWireUpToMs = 200;

	private readonly cfg: Config;
	private readonly scorer: Scorer;
	private readonly persistDir: string;
	private readonly sessionKey: string | null;

	private host!: ConductorHost;
	private off: (() => void) | null = null;
	private attached = false;

	// ── applied state (the FRONT buffer — what we have committed to the engine) ──
	private appliedFolds = new Map<string, string>(); // id → bare fold body
	private appliedStrata: AppliedStratum[] = [];
	private appliedPlan: Plan | null = null;

	// ── graduation (dwell + everWarm — persisted) ──
	private grad: { dwell: Map<string, number>; graduated: Set<string>; everWarm: Set<string> } = {
		dwell: new Map(),
		graduated: new Set(),
		everWarm: new Set(),
	};

	// ── scoring (from the attention probe) ──
	private scores = new Map<string, number>();
	private scoringInFlight = false;
	private rescoreNeeded = true;
	private attempted = new Set<string>();

	// ── agent/human touch tracking (resets dwell, vetoes graduation) ──
	private agentTouched = new Set<string>();
	private recalledThisEpoch = new Set<string>();

	// ── digest cache: key → LLM summary text (survives across epochs) ──
	private digestCache = new Map<string, string>();

	// ── PREPARE state ──
	private preparing = false;
	private prepareToken = 0;

	// ── per-tick / bookkeeping ──
	private gradAdvanced = false;
	private lastView: ConductorView | null = null;
	private restoredPendingValidation = false;
	private lastAction: "hold" | "epoch" | "emergency" = "hold";
	private lastFill = 0;
	private lastStatusText = "";
	private abort = new AbortController();

	constructor(opts: ThermoclineOptions = {}) {
		this.cfg = { ...DEFAULT_CFG, ...(opts.cfg ?? {}) };
		this.scorer = opts.scorer ?? scoreCandidates;
		this.persistDir = opts.persistDir ?? join(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");
		this.sessionKey = opts.sessionKey ?? null;
	}

	// ── Conductor lifecycle ─────────────────────────────────────────────────────
	attach(host: ConductorHost): void {
		this.host = host;
		this.attached = true;
		this.abort = new AbortController();
		this.restore();
		this.off = host.on((e) => this.onEvent(e));
	}

	detach(): void {
		this.attached = false;
		this.off?.();
		this.off = null;
		// Cancel any in-flight completions + probe; discard a pending prepare.
		this.abort.abort();
		++this.prepareToken;
		this.preparing = false;
	}

	// ── event routing ───────────────────────────────────────────────────────────
	private onEvent(e: HostEvent): void {
		if (!this.attached) return;
		switch (e.type) {
			case "blocks-appended":
			case "turn-committed":
				this.tick();
				break;
			case "state-changed":
				this.onStateChanged(e.changes);
				break;
			case "wire-departing":
				this.onWireDeparting();
				break;
			case "resync":
				this.onResync();
				break;
		}
	}

	/** Agent recall/unfold is graduation gate ②; a human edit resets graduation via `held` next tick. */
	private onStateChanged(changes: readonly StateChange[]): void {
		let sawAgentTouch = false;
		for (const c of changes) {
			// gate ②: consume by:"agent" edits — the "recall" what-variant AND agent "unfold".
			if (c.by === "agent" && (c.what === "recall" || c.what === "unfold") && c.id) {
				this.agentTouched.add(c.id);
				this.recalledThisEpoch.add(c.id);
				sawAgentTouch = true;
			}
			// humanOverride ids are NOT added here: the view's per-block `held` flag already reflects
			// them next tick and policy's graduation resets on `held`. Adding them would permanently
			// poison an id a human merely folded-then-unfolded.
		}
		// On ANY agent touch, UNCONDITIONALLY discard an in-flight prepare so the veto can't be missed:
		// the in-flight prepare's plan is local and may fold the touched unit. Agent unfolds are rare;
		// the next tick re-prepares if still needed.
		if (sawAgentTouch && this.preparing) {
			++this.prepareToken;
			this.preparing = false;
		}
	}

	/** The host state was rebuilt — drop tracked desired state and re-restore from disk. */
	private onResync(): void {
		this.appliedFolds.clear();
		this.appliedStrata = [];
		this.appliedPlan = null;
		this.grad = { dwell: new Map(), graduated: new Set(), everWarm: new Set() };
		this.scores.clear();
		this.attempted.clear();
		this.digestCache.clear();
		this.agentTouched.clear();
		this.recalledThisEpoch.clear();
		this.restore();
	}

	/** LAST-LINE HARD-CAP guarantee, right before the wire departs to the model. Strictly
	 *  deterministic (no LLM, no async, no inline disk I/O), so it fits the declared hold window. */
	private onWireDeparting(): void {
		const view = this.materialize();
		this.lastView = view;
		if (project(view, this.appliedForProject()) > capOf(view)) {
			this.runEmergency(view);
		}
	}

	// ── view + state adapters ─────────────────────────────────────────────────────
	private materialize(): ConductorView {
		const stats = this.host.stats();
		return {
			blocks: this.host.blocks().slice() as ViewBlock[],
			budget: stats.budget,
			contextWindow: stats.contextWindow,
			liveTokens: stats.liveTokens,
			protectedFromIndex: stats.protectedFromIndex,
			protectTokens: stats.protectTokens,
		};
	}

	private gradState(): ThermoState {
		return {
			dwell: this.grad.dwell,
			graduated: this.grad.graduated,
			everWarm: this.grad.everWarm,
			agentTouched: this.agentTouched,
			recalledThisEpoch: this.recalledThisEpoch,
		};
	}

	private appliedForProject(): Applied {
		return {
			foldedIds: new Set(this.appliedFolds.keys()),
			strata: this.appliedStrata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
		};
	}

	// ── the main steady-state tick ─────────────────────────────────────────────────
	private tick(): void {
		const view = this.materialize();
		this.lastView = view;
		this.gradAdvanced = false;

		this.validateRestoredStrata(view);

		const cap = capOf(view);
		const fill = cap > 0 ? project(view, this.appliedForProject()) / cap : 0;
		this.lastFill = fill;

		// everWarm tracks the latest scores on EVERY tick (before any graduation computation), so a
		// unit that became hot this tick already needs 2K before the graduation decision reads it.
		const units = buildUnits(view.blocks);
		for (const u of units) {
			const temp = this.scores.get(u.temperatureKey);
			if (temp !== undefined && temp >= this.cfg.coldThreshold) this.grad.everWarm.add(u.id);
		}

		this.pruneMaps(view, units);

		// EMERGENCY: already over budget — deterministic, immediate, no LLM.
		if (fill > 1.0) {
			this.runEmergency(view);
		}

		// ANTICIPATE: approaching warmWater and no prepare in flight → start one.
		if (fill >= this.cfg.warmWater && !this.preparing && this.needNewEpoch(fill)) {
			this.preparing = true;
			this.advanceGraduationOnce(view);
			const token = ++this.prepareToken;
			void this.prepareEpoch(view, token).catch(() => {
				this.preparing = false;
			});
		}

		// HOLD: re-derive from the committed plan and propose the delta if anything shifted.
		this.holdOrResend(view);

		// Background scoring: warm up scores for the next epoch (async, off this path).
		this.maybeScore(view);

		this.sendStatus();
	}

	/** A new epoch is warranted when there is no plan, OR the projected fill is already ≥ highWater. */
	private needNewEpoch(fill: number): boolean {
		if (!this.appliedPlan) return true;
		if (fill >= this.cfg.highWater) return true;
		return false;
	}

	/** Advance dwell at most ONCE per tick, and only when an epoch actually fires — so the K-epoch
	 *  probation is measured in compaction EPOCHS, not raw ticks. */
	private advanceGraduationOnce(view: ConductorView): void {
		if (this.gradAdvanced) return;
		this.gradAdvanced = true;
		const g = updateGraduation(this.gradState(), view, this.scores, this.cfg);
		this.grad.dwell = g.dwell;
		this.grad.graduated = g.graduated;
	}

	// ── EMERGENCY: deterministic plan, no LLM, immediate ─────────────────────────────
	private runEmergency(view: ConductorView): void {
		++this.prepareToken; // discard any in-flight prepare — the emergency commit is ground truth
		this.preparing = false;
		this.advanceGraduationOnce(view);
		const plan = planEpoch(view, this.scores, this.gradState(), this.cfg, {
			deterministic: true,
			graduated: this.grad.graduated,
		});
		this.commit(view, plan, undefined); // undefined digests → deterministic fallbacks everywhere
		this.lastAction = "emergency";
	}

	// ── PREPARE: score + LLM summaries + commit (async, off every hook path) ─────────
	private async prepareEpoch(view: ConductorView, token: number): Promise<void> {
		// 1. Plan (deterministic paths, no LLM yet). Graduation was advanced ONCE this tick.
		const plan = planEpoch(view, this.scores, this.gradState(), this.cfg, { graduated: this.grad.graduated });

		// 2. Fire host.complete for every digest/stratum not cached.
		const units = buildUnits(view.blocks);
		const byUnit = new Map(units.map((u) => [u.id, u]));
		const jobs: Promise<{ key: string; text: string } | null>[] = [];

		for (const f of plan.folds) {
			if (f.tier !== "digest") continue;
			if (this.digestCache.has(f.unitId)) continue;
			const u = byUnit.get(f.unitId);
			if (!u) continue;
			const { system, prompt } = buildDigestPrompt(u);
			jobs.push(
				this.host
					.complete({ system, prompt, maxOutputTokens: 120, signal: this.abort.signal })
					.then((r) => ({ key: f.unitId, text: r.text }))
					.catch(() => null), // rejection → null → emitOps falls back to deterministicDigest
			);
		}
		for (const s of plan.strata) {
			if (s.digestKind !== "summary") continue;
			const key = `stratum:${s.ids[0]}`;
			if (this.digestCache.has(key)) continue;
			const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean) as Unit[];
			if (!stratumUnits.length) continue;
			const { system, prompt } = buildStratumPrompt(stratumUnits);
			jobs.push(
				this.host
					.complete({ system, prompt, maxOutputTokens: 600, signal: this.abort.signal })
					.then((r) => ({ key, text: r.text }))
					.catch(() => null),
			);
		}

		const results = await Promise.allSettled(jobs);

		// A newer prepare or an emergency may have superseded this one. Discard cleanly — do NOT clear
		// `preparing` from a stale branch (the live owner manages that flag).
		if (this.prepareToken !== token) return;

		// Cache only real, non-empty text — an empty response must fall back to the deterministic tier,
		// not surface as a bare `{#code FOLDED}` tag with no body.
		for (const r of results) {
			if (r.status === "fulfilled" && r.value && r.value.text && r.value.text.trim()) {
				this.digestCache.set(r.value.key, r.value.text);
			}
		}

		// Re-plan on the LAST view (not the stale one) so the ops are fresh, then COMMIT atomically.
		const lv = this.lastView ?? view;
		const freshPlan = planEpoch(lv, this.scores, this.gradState(), this.cfg, { graduated: this.grad.graduated });
		if (this.attached) this.commit(lv, freshPlan, this.digestCache);
		this.preparing = false;
		this.sendStatus();
	}

	// ── COMMIT: reconcile + real tokens + top-up, then propose ONE transaction ─────────
	private commit(view: ConductorView, plan: Plan, digests: Map<string, string> | undefined): void {
		// (1) reconcile against reality: drop any fold/stratum the agent touched during PREPARE.
		const touched = unionSet(this.agentTouched, this.recalledThisEpoch);
		let working = reconcilePlan(plan, touched);
		// (2) substitute REAL summary tokens so the projection reflects the actual wire, then
		// (3) top up deterministically until projected ≤ cap with those real tokens.
		working = planWithRealStratumTokens(working, digests);
		working = this.topUpToCap(working, view, working.cap || capOf(view));

		const finalProjected = project(view, appliedShapeOf(working));
		working = { ...working, projected: finalProjected };

		// Diff the desired state against what we currently have applied and propose the delta.
		const desired = this.desiredFromPlan(working, digests, view);
		this.applyDesired(desired);
		this.appliedPlan = working;

		// Persist the deep zone AFTER commit, deferred off every hook path (never inline disk I/O).
		this.schedulePersist();

		// The epoch committed — the "agent touched this epoch" veto has been consumed.
		this.recalledThisEpoch = new Set();
		this.agentTouched = new Set();

		this.lastAction = "epoch";
		this.rescoreNeeded = true; // tail moved; rescore before the next epoch
		this.sendStatus();
	}

	/**
	 * BLOCKER 1 — guarantee the agent NEVER receives a batch whose projected live exceeds cap, using
	 * the REAL summary token counts. Deterministically merges extra folds/age-strata into the plan
	 * (skipping already-claimed units/members), then, if still over, drops our OWN strata oldest-first.
	 * Always terminates: the deterministic floor (folds + protected tail) is ≤ cap by planEpoch's
	 * hard-cap guarantee. Mutates + returns `plan`.
	 */
	private topUpToCap(plan: Plan, view: ConductorView, cap: number): Plan {
		if (project(view, appliedShapeOf(plan)) <= cap) return plan;

		const liveUnits = buildUnits(view.blocks);
		const memberIdsOfUnit = new Map(liveUnits.map((u) => [u.id, u.ids]));
		const claimedUnits = new Set<string>([...plan.folds.map((f) => f.unitId), ...plan.strata.flatMap((s) => s.unitIds)]);
		const foldedMembers = new Set<string>([...plan.folds.flatMap((f) => f.ids), ...plan.strata.flatMap((s) => s.memberIds)]);

		const MAX_PASSES = 3;
		for (let pass = 0; pass < MAX_PASSES; pass++) {
			if (project(view, appliedShapeOf(plan)) <= cap) return plan;
			const det = planEpoch(view, this.scores, this.gradState(), this.cfg, { deterministic: true, graduated: this.grad.graduated });
			let added = false;

			// Merge NEW deterministic folds (unit not already claimed, no member already folded).
			for (const f of det.folds) {
				if (claimedUnits.has(f.unitId)) continue;
				if (f.ids.some((id) => foldedMembers.has(id))) continue;
				plan.folds.push({ unitId: f.unitId, ids: f.ids, tier: f.tier });
				for (const id of f.ids) foldedMembers.add(id);
				claimedUnits.add(f.unitId);
				added = true;
			}
			// Merge NEW deterministic strata (no member already folded/claimed).
			for (const s of det.strata) {
				const units = s.unitIds ?? [];
				if (units.some((id) => claimedUnits.has(id))) continue;
				if (s.memberIds.some((id) => foldedMembers.has(id))) continue;
				plan.strata.push({
					ids: s.ids,
					unitIds: units,
					memberIds: s.memberIds,
					digestKind: s.digestKind,
					summaryTokens: s.summaryTokens,
				});
				for (const id of units) claimedUnits.add(id);
				for (const id of s.memberIds) foldedMembers.add(id);
				for (const uid of units) for (const mid of memberIdsOfUnit.get(uid) ?? []) foldedMembers.add(mid);
				added = true;
			}

			if (project(view, appliedShapeOf(plan)) <= cap) return plan;
			if (!added) break; // no NEW moves — fall through to dropping our own strata
		}

		// Last resort: drop our OWN strata oldest-first (frees real tokens) until ≤ cap.
		dropOwnStrataOldestFirst(plan, view, cap);
		return plan;
	}

	/** HOLD — re-derive the desired state from the committed plan against the CURRENT view and
	 *  propose only the delta. An unchanged desired state yields an empty transaction (the diff IS
	 *  the signature-dedup). Also the seam that first applies a restored deep zone to the engine. */
	private holdOrResend(view: ConductorView): void {
		if (!this.appliedPlan) return;
		const desired = this.desiredFromPlan(this.appliedPlan, this.digestCache, view);
		this.applyDesired(desired);
	}

	// ── desired state + diff ────────────────────────────────────────────────────────
	private desiredFromPlan(plan: Plan, digests: Map<string, string> | undefined, view: ConductorView): Desired {
		const units = buildUnits(view.blocks);
		const byUnit = new Map(units.map((u) => [u.id, u]));
		const folds = new Map<string, string>();
		for (const f of plan.folds) {
			const u = byUnit.get(f.unitId);
			if (!u) continue;
			const ids = foldableMemberIds(u, f.ids);
			if (!ids.length) continue;
			const body = foldBody(u, f.tier, digests);
			for (const id of ids) folds.set(id, body);
		}
		const strata = plan.strata.map((s) => {
			const drop = s.digestKind === "drop";
			const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean) as Unit[];
			return {
				firstId: s.ids[0],
				lastId: s.ids[1],
				unitIds: s.unitIds.slice(),
				memberIds: s.memberIds.slice(),
				summary: drop ? null : stratumSummary(stratumUnits, s.ids[0], digests),
				summaryTokens: s.summaryTokens,
			};
		});
		return { folds, strata };
	}

	/** Diff `desired` against the applied state and propose ONE transaction (undo removed folds/
	 *  strata, then apply new/changed ones). Update the applied state from what actually applied. */
	private applyDesired(desired: Desired): void {
		const stratumKey = (firstId: string, lastId: string) => `${firstId}|${lastId}`;
		const desiredStrataByKey = new Map(desired.strata.map((s) => [stratumKey(s.firstId, s.lastId), s]));
		const desiredStratumMembers = new Set(desired.strata.flatMap((s) => s.memberIds));

		const ops: Op[] = [];
		// 1. Ungroup strata no longer desired, or whose summary changed.
		for (const old of this.appliedStrata) {
			const want = desiredStrataByKey.get(stratumKey(old.firstId, old.lastId));
			if ((!want || want.summary !== old.summary) && old.groupId) ops.push({ kind: "ungroup", groupId: old.groupId });
		}
		// 2. Undo folds no longer desired, or now swept into a desired stratum.
		for (const [id] of this.appliedFolds) {
			if (!desired.folds.has(id) || desiredStratumMembers.has(id)) ops.push({ kind: "auto", ids: [id] });
		}
		// 3. Apply new / changed folds (skip a member now grouped).
		for (const [id, body] of desired.folds) {
			if (desiredStratumMembers.has(id)) continue;
			if (this.appliedFolds.get(id) !== body) ops.push({ kind: "replace", id, content: body, recoverable: true });
		}
		// 4. Apply new / changed strata (a changed one was ungrouped in step 1, so this re-creates it).
		//    `groupId == null` means a restored stratum tracked in memory but not yet grouped in the
		//    engine — emit the group so the first HOLD after a restore actually applies the deep zone.
		for (const s of desired.strata) {
			const prior = this.appliedStrata.find((p) => p.firstId === s.firstId && p.lastId === s.lastId);
			if (!prior || prior.summary !== s.summary || prior.groupId == null) {
				ops.push({ kind: "group", ids: [s.firstId, s.lastId], summary: s.summary });
			}
		}

		if (!ops.length) return;

		const baseRev = this.host.stats().rev;
		const res = this.host.propose({ baseRev, ops });

		// Reconcile the tracked applied state with what ACTUALLY applied (a clamped op must not enter).
		for (const r of res.results) {
			if (!r.applied) continue;
			const op = r.op;
			if (op.kind === "auto") {
				for (const id of op.ids) this.appliedFolds.delete(id);
			} else if (op.kind === "replace") {
				this.appliedFolds.set(op.id, op.content);
			} else if (op.kind === "ungroup") {
				this.appliedStrata = this.appliedStrata.filter((s) => s.groupId !== op.groupId);
			} else if (op.kind === "group") {
				const d = desiredStrataByKey.get(stratumKey(op.ids[0], op.ids[op.ids.length - 1]));
				if (d) {
					// Drop any prior entry for this range, then record the fresh group id.
					this.appliedStrata = this.appliedStrata.filter((s) => !(s.firstId === d.firstId && s.lastId === d.lastId));
					this.appliedStrata.push({
						firstId: d.firstId,
						lastId: d.lastId,
						unitIds: d.unitIds,
						memberIds: d.memberIds,
						summary: d.summary,
						summaryTokens: d.summaryTokens,
						groupId: r.detail ?? `g:${d.firstId}`,
					});
				}
			}
		}
	}

	// ── background scoring ──────────────────────────────────────────────────────────
	private maybeScore(view: ConductorView): void {
		const units = buildUnits(view.blocks);
		const cands = units.filter((u) => !u.protected && !u.held && !this.attempted.has(u.temperatureKey));
		const fill = this.lastFill;

		if (fill < this.cfg.warmWater || this.scoringInFlight || !(this.rescoreNeeded || cands.length)) return;
		if (!cands.length) return;

		const tailText = tailTextFromView(view.blocks);
		if (!tailText.trim()) return; // no work tail to score against

		this.scoringInFlight = true;
		const candidates = cands.map((u) => ({ id: u.temperatureKey, text: u.blocks.map((b) => b.text ?? "").join("\n") }));
		const ids = candidates.map((c) => c.id);

		this.scorer({ tailText, candidates, signal: this.abort.signal })
			.then((scores) => {
				for (const [id, v] of scores) this.scores.set(id, v);
				this.attempted = new Set(ids); // REPLACE so a unit can be re-scored on the next rescoreNeeded
				this.rescoreNeeded = false;
				this.scoringInFlight = false;
				this.sendStatus();
			})
			.catch(() => {
				// GRACEFUL DEGRADATION: probe/python/torch absent, spawn failure, or timeout → scores
				// stay whatever they were (possibly empty). The policy's age-based rung 3.5 carries on.
				this.scoringInFlight = false;
				this.sendStatus();
			});
	}

	// ── map pruning (bound per-session memory) ──────────────────────────────────────
	private pruneMaps(view: ConductorView, units: Unit[]): void {
		const liveBlockIds = new Set(view.blocks.map((b) => b.id));
		const liveTempKeys = new Set(units.map((u) => u.temperatureKey));
		const liveUnitIds = new Set(units.map((u) => u.id));
		for (const k of this.scores.keys()) if (!liveTempKeys.has(k)) this.scores.delete(k);
		for (const k of this.attempted) if (!liveTempKeys.has(k)) this.attempted.delete(k);
		for (const k of this.digestCache.keys()) {
			const stale = k.startsWith("stratum:") ? !liveBlockIds.has(k.slice("stratum:".length)) : !liveUnitIds.has(k);
			if (stale) this.digestCache.delete(k);
		}
	}

	// ── restore + validate persisted state ──────────────────────────────────────────
	private restore(): void {
		if (!this.sessionKey) return;
		const saved = this.loadPersisted();
		if (!saved) return;
		const savedStrata = Array.isArray(saved.strata)
			? saved.strata.filter((s) => Array.isArray(s.unitIds) && s.unitIds.length > 0)
			: [];
		if (savedStrata.length) {
			this.appliedStrata = savedStrata.map((s) => ({ ...s, unitIds: s.unitIds.slice(), memberIds: s.memberIds.slice() }));
			for (const s of savedStrata) {
				if (s.summary != null) this.digestCache.set(`stratum:${s.firstId}`, stripTag(s.summary));
			}
			// A synthetic plan so holdOrResend can emit the restored strata on the first tick. No folds
			// (those re-derive from scores). projected/cap/targetTokens are sentinels (unused by hold).
			this.appliedPlan = {
				folds: [],
				strata: this.appliedStrata.map((s) => ({
					ids: [s.firstId, s.lastId] as [string, string],
					unitIds: s.unitIds.slice(),
					memberIds: s.memberIds.slice(),
					digestKind: s.summary == null ? "drop" : "summary",
					summaryTokens: s.summaryTokens ?? 0,
				})),
				projected: 0,
				cap: 0,
				targetTokens: 0,
			};
			// The restored strata are only in conductor memory; the engine has no groups for them yet,
			// so `appliedStrata[i].groupId` is null until the first holdOrResend actually groups them.
			for (const s of this.appliedStrata) s.groupId = null;
			this.restoredPendingValidation = true;
		}
		if (Array.isArray(saved.dwell)) this.grad.dwell = new Map(saved.dwell);
		if (Array.isArray(saved.everWarm)) this.grad.everWarm = new Set(saved.everWarm);
	}

	/** On the first real view after a restore, drop any stratum with a member id absent from the view
	 *  (an interior member can vanish while boundary ids survive — project() would stay low forever and
	 *  the group could swallow drifted-in live blocks). A stratum is safe only if EVERY member is live. */
	private validateRestoredStrata(view: ConductorView): void {
		if (!this.restoredPendingValidation) return;
		this.restoredPendingValidation = false;
		const liveIds = new Set(view.blocks.map((b) => b.id));
		const valid = this.appliedStrata.filter(
			(s) =>
				liveIds.has(s.firstId) &&
				liveIds.has(s.lastId) &&
				Array.isArray(s.memberIds) &&
				s.memberIds.length > 0 &&
				s.memberIds.every((id) => liveIds.has(id)),
		);
		if (valid.length !== this.appliedStrata.length) {
			this.appliedStrata = valid;
			this.appliedPlan = valid.length
				? {
						folds: [],
						strata: valid.map((s) => ({
							ids: [s.firstId, s.lastId] as [string, string],
							unitIds: s.unitIds.slice(),
							memberIds: s.memberIds.slice(),
							digestKind: s.summary == null ? "drop" : "summary",
							summaryTokens: s.summaryTokens ?? 0,
						})),
						projected: 0,
						cap: 0,
						targetTokens: 0,
					}
				: null;
		}
	}

	private loadPersisted(): PersistedState | null {
		if (!this.sessionKey) return null;
		try {
			return JSON.parse(readFileSync(persistPath(this.persistDir, this.sessionKey), "utf8")) as PersistedState;
		} catch {
			return null;
		}
	}

	/** Defer persistence off EVERY hook path (invariant: no disk I/O on a pre-model-call hook). */
	private schedulePersist(): void {
		if (!this.sessionKey) return;
		queueMicrotask(() => this.persistNow());
	}

	private persistNow(): void {
		if (!this.sessionKey) return;
		try {
			mkdirSync(this.persistDir, { recursive: true });
		} catch {
			return; // can't even make the dir — give up silently
		}
		const data: PersistedState = {
			strata: this.appliedStrata.map((s) => ({ ...s })),
			dwell: [...this.grad.dwell.entries()],
			everWarm: [...this.grad.everWarm],
		};
		const p = persistPath(this.persistDir, this.sessionKey);
		const tmp = `${p}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(data, null, 2));
			renameSync(tmp, p); // atomic
		} catch {
			/* best-effort — the deep zone is regenerable from a fresh epoch */
		}
	}

	// ── status ──────────────────────────────────────────────────────────────────────
	private sendStatus(): void {
		const pct = Math.round((Number.isFinite(this.lastFill) ? this.lastFill : 0) * 100);
		const folded = this.appliedFolds.size;
		const strata = this.appliedStrata.length;
		const action = this.preparing ? "PREPARE" : this.lastAction === "emergency" ? "EMERGENCY" : "HOLD";
		const scoring = this.scoringInFlight ? " · scoring…" : "";
		const text = `${action} ${pct}% · ${folded} folded · ${strata} strata${scoring}`;
		if (text === this.lastStatusText) return;
		this.lastStatusText = text;
		this.host.setStatus(text, {
			fullness: pct,
			action,
			folded,
			strata,
			scoring: this.scoringInFlight,
			lowWater: Math.round(this.cfg.lowWater * 100),
			highWater: Math.round(this.cfg.highWater * 100),
		});
	}
}

// ── commit helpers (pure — ported from thermocline.mjs) ─────────────────────────────

/** Strip a leading `{#code FOLDED}` tag from a restored summary so the cache holds the bare body
 *  (stratumSummary re-adds the tag). Mirrors the engine's own tag-stripping on recoverable replace. */
function stripTag(s: string): string {
	return s.replace(/^\s*\{#[0-9a-z]{6} FOLDED\}\s*/, "");
}

/** The project()-shape applied state derived from a working plan's folds + strata. */
function appliedShapeOf(plan: Plan): Applied {
	return {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
}

/**
 * Drop any fold/stratum the agent recalled, unfolded, or re-warmed during PREPARE before the epoch
 * is swapped in — belt-and-suspenders with the round-1 discard-on-agentUnfold. Returns a NEW plan.
 */
export function reconcilePlan(plan: Plan, touched: Set<string>): Plan {
	if (!touched || touched.size === 0) return plan;
	const folds = plan.folds.filter((f) => !f.ids.some((id) => touched.has(id)));
	const strata = plan.strata.filter((s) => !s.memberIds.some((id) => touched.has(id)));
	if (folds.length === plan.folds.length && strata.length === plan.strata.length) return plan;
	return { ...plan, folds, strata };
}

/** Substitute REAL LLM-summary token counts into a plan's strata (the digest text length), so the
 *  projection reflects what the agent will actually receive — not planEpoch's ~12% estimate. */
export function planWithRealStratumTokens(plan: Plan, digests: Map<string, string> | undefined): Plan {
	const d = digests ?? new Map<string, string>();
	const strata = plan.strata.map((s) => {
		if (s.digestKind === "drop") return s; // a drop contributes 0 — no real text
		const summary = d.get(`stratum:${s.ids[0]}`);
		if (summary == null) return s; // no LLM text yet → keep the estimate
		return { ...s, summaryTokens: Math.ceil(summary.length / 4) };
	});
	return { ...plan, strata };
}

/** Convert a plan's OWN strata to drops OLDEST-FIRST (conversation order) until project() ≤ bound. */
export function dropOwnStrataOldestFirst(plan: Plan, view: ConductorView, bound: number): boolean {
	const orderOf = new Map(view.blocks.map((b) => [b.id, b.order]));
	const sorted = plan.strata
		.map((s) => ({ s, ord: orderOf.get(s.ids[0]) ?? Infinity }))
		.sort((a, b) => a.ord - b.ord);
	let dropped = false;
	for (const { s } of sorted) {
		if (project(view, appliedShapeOf(plan)) <= bound) break;
		if (s.digestKind !== "drop") {
			s.digestKind = "drop";
			s.summaryTokens = 0;
			dropped = true;
		}
	}
	return dropped;
}


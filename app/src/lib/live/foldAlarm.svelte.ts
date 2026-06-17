/*
 * foldAlarm.svelte.ts — the view↔wire divergence ALARM (indicator-only, never heals).
 *
 * The whole point of `wireFoldable` (engine/digest.ts) is that the screen can NEVER
 * show a per-block fold the agent's wire would refuse — the foldability gate lives in
 * ONE place and both `store.fold()`/`isFolded` AND `computeFoldOps` consult it. This
 * module is the BACKSTOP that watches for any residual divergence after those gates and
 * surfaces it as a single header dot. It is a tripwire, not a mechanism: it NEVER mutates
 * the store, NEVER throws, NEVER self-heals. In production it is purely an indicator; in
 * dev it additionally logs the first diverging block. If this alarm ever fires, a gate
 * upstream has a bug — fix the gate, never relax the alarm.
 *
 * THREE LAYERS (in order of severity):
 *
 *   1. UNIVERSAL (all modes) — a per-block fold that the wire's KIND gate would refuse.
 *      For every block that is NOT a collapsed folded-group member: if it reads folded in
 *      the view (`isFolded`) but `wireFoldable(b)` is false, that is a UI lie — a recessed
 *      tile / saved tokens for content the agent still receives whole. This should be
 *      impossible after the fold doors are gated on `wireFoldable`; the alarm is the
 *      "should never fire" proof. Folded-group members are EXCLUDED because group collapse
 *      (ADR 0006) is a SEPARATE structural mechanism that legitimately removes whole
 *      `tool_call`/`user` messages — a collapsed tool_call member is not a lie.
 *
 *   2. LIVE-ONLY — `viewSet` (per-block folds the view shows) vs `wireSet` (the per-block
 *      folds `computeFoldOps` produces) must be IDENTICAL. Note `computeFoldOps` is the
 *      WOULD-BE ARMED plan: when `folding.enabled` is off the agent's actual wire is empty,
 *      but the correct comparison is still the would-be plan, NOT the empty disarmed wire —
 *      per the CLAUDE.md rule, preview/listening must match what steering WOULD send, so a
 *      fold the armed plan would refuse is a lie even while disarmed. (That is why this layer
 *      gates on connection, not on `folding.enabled`.) The interesting residual case it
 *      catches: a foldable-kind block folded in the view but dropped by `computeFoldOps`
 *      because its id is non-durable (`isDurableId` false) — INTENDED to fire, since the view
 *      shows a fold steering would silently not perform. Gated to live because off-wire / demo
 *      / Claude-Code sessions use non-durable on-disk ids, so `computeFoldOps` is empty there
 *      and this check would false-positive on every fold (the id-format reconciliation that
 *      would let it run off-wire is deferred to Slice 2).
 *
 *   3. NOT VERIFIED (documented, deliberately) — folded-GROUP member balance (stragglers).
 *      The extension's `applyPlan` re-derives which group members are actually removed
 *      (balanced tool-pairs) against pi's live message array — which the APP does not have.
 *      So this alarm does NOT compare `computeGroupOps` member sets against the view; doing
 *      so naively would false-positive on every legitimate straggler. That divergence (a
 *      known ADR-0006 accounting gap) stays covered by the extension's last-resort structural
 *      guard and a deferred Slice 2. DO NOT "fix" this alarm by adding a group member
 *      comparison.
 *
 * O(n) over `store.blocks`. The writer takes `isLive` as an argument (not a `live`/`session`
 * import) to stay free of import cycles with the modules that drive it.
 */
import type { AccordionStore } from "../engine/store.svelte";
import type { Block } from "../engine/types";
import { wireFoldable } from "../engine/digest";
import { computeFoldOps } from "./plan";

/** Indicator-only alarm state. `active` drives the header dot; `detail` names the first divergence. */
export const foldAlarm = $state<{ active: boolean; detail: string }>({ active: false, detail: "" });

/** Is `b` a member of a COLLAPSED (folded) group? Such members are exempt from the universal check. */
function inFoldedGroup(store: AccordionStore, b: Block): boolean {
	return store.groupOf(b)?.folded === true;
}

/**
 * Recompute the alarm for the current settled store state. Pure read of the store — it
 * never mutates and never throws. Sets `foldAlarm.active`/`.detail`. In dev, a mismatch
 * also logs the first diverging block via `console.error`; production stays indicator-only.
 *
 * @param store   the active session store
 * @param isLive  true iff a live pi wire is connected (gates Layer 2 — see file doc)
 */
export function runFoldCheck(store: AccordionStore, isLive: boolean): void {
	let mismatch = false;
	let detail = "";

	// ── Layer 1: universal kind gate (runs in ALL modes) ──────────────────────────
	// A folded, non-grouped block whose kind the wire would never fold is a UI lie.
	for (const b of store.blocks) {
		if (inFoldedGroup(store, b)) continue; // group collapse is a separate, legit mechanism
		if (store.isFolded(b) && !wireFoldable(b)) {
			mismatch = true;
			detail = `block ${b.id} (kind ${b.kind}) reads FOLDED on screen but the wire would never fold its kind — the agent receives it whole`;
			break;
		}
	}

	// ── Layer 2: live-only symmetric-difference of view folds vs emitted wire folds ──
	if (!mismatch && isLive) {
		// viewSet — per-block folds the view shows (folded, not a collapsed-group member).
		const viewSet = new Set<string>();
		for (const b of store.blocks) {
			if (store.isFolded(b) && !inFoldedGroup(store, b)) viewSet.add(b.id);
		}
		// wireSet — the would-be ARMED wire plan (what computeFoldOps emits if steering is on).
		// Comparing against this, not the possibly-empty disarmed wire, is intentional: preview
		// must match what steering WOULD send (CLAUDE.md). See the Layer 2 note in the file doc.
		const wireSet = new Set<string>(computeFoldOps(store).map((op) => op.id));

		// In view but NOT on the wire — the screen shows a fold the agent never receives
		// (e.g. a foldable-kind block dropped by computeFoldOps for a non-durable id).
		for (const id of viewSet) {
			if (!wireSet.has(id)) {
				const b = store.get(id);
				mismatch = true;
				detail = `block ${id}${b ? ` (kind ${b.kind})` : ""} reads FOLDED on screen but is NOT in the wire fold plan — the agent receives it whole`;
				break;
			}
		}
		// On the wire but NOT in view — the agent would receive a fold the screen never shows.
		if (!mismatch) {
			for (const id of wireSet) {
				if (!viewSet.has(id)) {
					mismatch = true;
					detail = `block ${id} is in the wire fold plan but does NOT read FOLDED on screen — the agent's fold disagrees with the view`;
					break;
				}
			}
		}
	}

	foldAlarm.active = mismatch;
	foldAlarm.detail = mismatch ? detail : "";

	// Dev-only diagnostic. First use of import.meta.env.DEV in this codebase — idiomatic
	// Vite, statically replaced, so production carries no console call / no halt / no heal.
	if (import.meta.env.DEV && mismatch) {
		// eslint-disable-next-line no-console
		console.error("[fold-alarm] view↔wire mismatch:", detail);
	}
}

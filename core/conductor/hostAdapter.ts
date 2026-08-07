/*
 * hostAdapter.ts — framework-free, dependency-free derivation of `HostEvent`s (the frozen
 * conductor-v2 contract, `./contract`) from a `Truth` and its `TruthEvent`s (`../events`).
 *
 * `TestHost` (`./testhost.ts`) was, until Phase C, the ONLY place this derivation existed — every
 * shipped conductor (`conductors/in-process/**`, `conductors/ws/thermocline/**`) is golden-tested against
 * exactly what TestHost derives. Phase C needs the SAME derivation in two more places (the
 * in-extension live host, the out-of-process remote SDK), so it is extracted here rather than
 * re-derived — a second hand-rolled copy would risk drifting from what those conductors were
 * validated against. `TestHost` now consumes these functions instead of its own private copies.
 *
 * Every export here is a pure function of its arguments (plus read-only `Truth` queries) — no
 * subscriptions, no side effects, no host-lifecycle state. A host wires these into its own
 * `Truth.onEvent` subscription and its own `fire`/`listeners` plumbing.
 */
import type { Block, Actor } from "../types";
import type { Truth } from "../truth";
import type { TruthEvent } from "../events";
import type { Op } from "../ops";
import type { HostEvent, ViewBlock, StateChange } from "./contract";

/**
 * Project one Truth block into the `ViewBlock` shape every conductor/host client sees — the
 * per-block read a `ConductorHost.get`/`blocks()` implementation serves.
 *
 * `tokens`/`foldedTokens` are CALIBRATED (issue #11 stage 2, ADR 0025 — `truth.calTokens`), not the
 * raw chars/4 estimate `Block.tokens`/`foldedTokensOf` carry — see `TruthStats`'s doc comment
 * (`core/truth.ts`) for why every conductor-facing read surface shares this one convention.
 */
export function viewBlockOf(truth: Truth, b: Block): ViewBlock {
	return {
		id: b.id,
		kind: b.kind,
		turn: b.turn,
		order: b.order,
		tokens: truth.calTokens(b.tokens),
		foldedTokens: truth.calTokens(truth.foldedTokensOf(b)),
		toolName: b.toolName,
		callId: b.callId,
		isError: b.isError,
		held: truth.held(b),
		folded: truth.isFolded(b),
		protected: truth.isProtected(b),
		grouped: truth.inFoldedGroup(b.id),
		sent: truth.sent(b),
		text: b.text,
	};
}

/**
 * Map one applied `Op` to the `StateChange` a conductor observes via `state-changed`, or `null`
 * when the op carries no steering signal a conductor should react to. `freeze` (Phase C's
 * conductor-detach kill switch, `../ops.ts`) is host-only bookkeeping — it rides the same
 * `ops-applied` TruthEvent as any other op (so replicas replay it identically), but it is never a
 * `StateChange`: reassigning ownership on detach is not something an (already-detaching)
 * conductor needs to react to.
 */
export function stateChangeFromOp(op: Op, by: Actor): StateChange | null {
	switch (op.kind) {
		case "fold":
			return { id: op.ids[0], what: "fold", by };
		case "replace":
			return { id: op.id, what: "replace", by };
		case "unfold":
			return { id: op.ids[0], what: "unfold", by };
		case "auto":
			return { id: op.ids[0], what: "unfold", by };
		case "pin":
			return { id: op.ids[0], what: "pin", by };
		case "unpin":
			return { id: op.ids[0], what: "unpin", by };
		case "group":
			return { groupId: op.ids.join("|"), what: "group", by };
		case "ungroup":
			return { groupId: op.groupId, what: "ungroup", by };
		case "foldGroup":
			return { groupId: op.groupId, what: "group", by };
		case "unfoldGroup":
			return { groupId: op.groupId, what: "ungroup", by };
		case "resetAll":
			return { what: "unfold", by };
		case "freeze":
			return null; // host bookkeeping — never a steering signal a conductor reacts to
	}
}

/**
 * Map one Truth event to the 0..n `HostEvent`s a host should fire to its subscribed conductors.
 * `locks` and `sent` are not surfaced as HostEvents in Phase A/B/C — a host that wants to expose
 * them adds its own event kind on top of this.
 */
export function hostEventsFromTruthEvent(truth: Truth, e: TruthEvent): HostEvent[] {
	if (e.type === "appended") {
		const s = truth.stats();
		return [{ type: "blocks-appended", blocks: e.blocks.map((b) => viewBlockOf(truth, b)), rev: e.rev, liveTokens: s.liveTokens, budget: s.budget }];
	}
	if (e.type === "ops-applied") {
		const changes: StateChange[] = [];
		for (const r of e.results) {
			if (!r.applied) continue;
			const c = stateChangeFromOp(r.op, e.by);
			if (c) changes.push(c);
		}
		return changes.length ? [{ type: "state-changed", changes, rev: e.rev }] : [];
	}
	if (e.type === "config") {
		// `calibration` (v18, issue #11 stage 1) is DISPLAY-only and must stay invisible to a
		// conductor — it carries no `budget`/`protectTokens`/`contextWindow` field, so without this
		// guard it would fall through to the `budget !== undefined ? "budget" : "protect"` default and
		// get mislabeled a "protect" change, waking every subscribed conductor on every calibration
		// snap (once per model reply) for a dial it was never meant to see.
		if (e.budget === undefined && e.protectTokens === undefined && e.contextWindow === undefined) return [];
		const what: StateChange["what"] = e.budget !== undefined ? "budget" : "protect";
		return [{ type: "state-changed", changes: [{ what, by: "you" }], rev: e.rev }];
	}
	if (e.type === "reset") {
		// A wholesale reset drops every strategy fold — subscribed conductors rebuild.
		return [{ type: "resync", rev: e.rev }];
	}
	// "locks" / "sent" are not surfaced as HostEvents in Phase A.
	return [];
}

/**
 * Synthesize the `state-changed`/"recall" HostEvent for an agent `recall` observation
 * (host-layer, refinement 5). Recall is a pure READ — it does not mutate fold state, so Truth
 * itself never emits it; the host layer surfaces it so a conductor that treats "the agent reached
 * back into this block" as a signal can observe it. `ids` may be more than one (e.g. a single
 * `recall` tool call naming several codes) — one `StateChange` per id, all sharing `by`/`rev`.
 */
export function recallHostEvent(ids: string[], by: Actor, rev: number): HostEvent {
	return { type: "state-changed", changes: ids.map((id) => ({ id, what: "recall" as const, by })), rev };
}

/**
 * Compute the `wire-departing` HostEvent for the CURRENT Truth state, plus the highest block
 * `order` the caller should mark sent once the wire actually departs (`null` when there are no
 * blocks at all yet). Split this way because firing the event and marking sent are two distinct
 * steps in the host's lifecycle (a synchronous listener gets to propose a last-moment fold BEFORE
 * the caller advances the sent cursor) — see `TestHost.departWire` for the canonical sequencing.
 */
export function wireDepartingEvent(truth: Truth): { event: Extract<HostEvent, { type: "wire-departing" }>; lastOrder: number | null } {
	const blocks = truth.blocks;
	const freshIds = blocks.filter((b) => !truth.sent(b)).map((b) => b.id);
	const s = truth.stats();
	return {
		event: { type: "wire-departing", rev: truth.rev, liveTokens: s.liveTokens, budget: s.budget, freshIds },
		lastOrder: blocks.length ? blocks[blocks.length - 1].order : null,
	};
}

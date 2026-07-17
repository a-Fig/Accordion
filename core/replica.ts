/*
 * replica.ts — Phase B (de)serialization between the authoritative Truth host (the extension)
 * and a replica Truth (a client). Framework-free, pure.
 *
 *   HOST  →  serializeSnapshot(truth, foldingEnabled) → SnapshotState  (full state, rev-stamped)
 *   HOST  →  wireEventFromTruthEvent(truthEvent)       → WireEvent      (replayable input)
 *   CLIENT←  hydrateSnapshot(meta, state)              → Truth          (rev-aligned replica)
 *   CLIENT←  applyWireEvent(truth, wireEvent)          → void           (replay onto the replica)
 *
 * The replica replays inputs through its OWN Truth and asserts its post-replay `rev` equals the
 * event's — a mismatch means it diverged (dropped event, non-determinism) and must resnapshot.
 */
import type { Block, Group, SessionMeta } from "./types";
import { Truth } from "./truth";
import type { TruthEvent } from "./events";
import { wireToBlock } from "./wire";
import type { WireBlock, WireOverlay, SnapshotState, WireEvent } from "./protocol";

/** Block → WireBlock (drops the reactive overlay; overlay travels separately). */
export function blockToWire(b: Block): WireBlock {
	return {
		id: b.id,
		kind: b.kind,
		turn: b.turn,
		order: b.order,
		text: b.text,
		tokens: b.tokens,
		toolName: b.toolName,
		callId: b.callId,
		model: b.model,
		isError: b.isError,
	};
}

/** True iff this block's overlay differs from a fresh (append-time) block. */
function hasOverlay(b: Block): boolean {
	return b.override !== null || b.autoFolded || b.subst !== undefined || b.by !== null;
}

/** Serialize the full authoritative state so a client can (re)build a rev-aligned replica. */
export function serializeSnapshot(truth: Truth, foldingEnabled: boolean): SnapshotState {
	const overlay: WireOverlay[] = [];
	for (const b of truth.blocks) {
		if (hasOverlay(b)) overlay.push({ id: b.id, override: b.override, autoFolded: b.autoFolded, by: b.by, subst: b.subst });
	}
	return {
		blocks: truth.blocks.map(blockToWire),
		overlay,
		groups: truth.groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() })),
		budget: truth.budget,
		contextWindow: truth.contextWindow,
		protectTokens: truth.protectTokens,
		locks: truth.locks.slice(),
		lockHolder: truth.lockHolder,
		tailTokens: truth.activeTailTokens,
		sentThroughOrder: truth.sentThroughOrder,
		wireAttached: truth.wireAttached,
		foldingEnabled,
		rev: truth.rev,
	};
}

/** Build a rev-aligned replica Truth from a snapshot. `meta` comes from the `hello` frame. */
export function hydrateSnapshot(meta: SessionMeta, state: SnapshotState): Truth {
	const overlayById = new Map<string, WireOverlay>();
	for (const o of state.overlay) overlayById.set(o.id, o);
	const blocks: Block[] = state.blocks.map((w) => {
		const b = wireToBlock(w);
		const o = overlayById.get(w.id);
		if (o) {
			b.override = o.override;
			b.autoFolded = o.autoFolded;
			b.by = o.by;
			b.subst = o.subst;
		}
		return b;
	});
	const groups: Group[] = state.groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() }));
	const truth = new Truth({ meta, blocks: [], lineCount: 0, skipped: 0 });
	truth.adoptSnapshot({
		blocks,
		groups,
		budget: state.budget,
		contextWindow: state.contextWindow,
		protectTokens: state.protectTokens,
		locks: state.locks,
		lockHolder: state.lockHolder,
		tailTokens: state.tailTokens,
		sentThroughOrder: state.sentThroughOrder,
		wireAttached: state.wireAttached,
		rev: state.rev,
	});
	return truth;
}

/**
 * Map a host TruthEvent to the REPLAYABLE INPUT the replica needs, or null when nothing needs to
 * ride the wire. For `ops-applied` we forward ONLY the ops that actually applied — the replica
 * replays without a baseRev, so a clamped/stale op must never be re-offered (it would apply on the
 * replica and diverge). `reset` is attributed to "you" (the only actor that triggers resetAll in
 * Phase B); resetAll clears every provenance to null anyway.
 */
export function wireEventFromTruthEvent(e: TruthEvent): WireEvent | null {
	switch (e.type) {
		case "appended":
			return { kind: "appended", blocks: e.blocks.map(blockToWire), rev: e.rev };
		case "ops-applied": {
			const ops = e.results.filter((r) => r.applied).map((r) => r.op);
			if (!ops.length) return null;
			return { kind: "ops", by: e.by, ops, rev: e.rev };
		}
		case "config":
			return { kind: "config", budget: e.budget, contextWindow: e.contextWindow, protectTokens: e.protectTokens, rev: e.rev };
		case "locks":
			return { kind: "locks", locks: e.locks.slice(), holder: e.holder, tailTokens: e.tailTokens, rev: e.rev };
		case "sent":
			return { kind: "sent", throughOrder: e.throughOrder, rev: e.rev };
		case "reset":
			return { kind: "reset", by: "you", rev: e.rev };
	}
}

/** Replay a WireEvent onto a replica Truth (which emits its own TruthEvents to any subscriber). */
export function applyWireEvent(truth: Truth, ev: WireEvent): void {
	switch (ev.kind) {
		case "appended":
			truth.append(ev.blocks.map(wireToBlock));
			return;
		case "ops":
			truth.apply(ev.ops, ev.by);
			return;
		case "config":
			if (ev.budget !== undefined) truth.setBudget(ev.budget);
			if (ev.contextWindow !== undefined) truth.setContextWindow(ev.contextWindow);
			if (ev.protectTokens !== undefined) truth.setProtect(ev.protectTokens);
			return;
		case "locks":
			if (ev.locks.length) truth.setLocks(ev.locks, ev.holder ?? "", ev.tailTokens);
			else truth.clearLocks();
			return;
		case "sent":
			truth.markSent(ev.throughOrder);
			return;
		case "reset":
			truth.apply([{ kind: "resetAll" }], ev.by);
			return;
	}
}

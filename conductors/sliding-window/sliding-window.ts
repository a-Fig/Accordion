/*
 * sliding-window.ts — "just drop old context" conductor.
 *
 * Simulates the strategy used by many AI coding tools: once the context grows
 * past a threshold, discard a chunk of the oldest non-user content. User messages
 * are always preserved (they carry intent). Protected tail is respected.
 *
 * Fires in discrete chops, not continuously:
 *  - Threshold: liveTokens > budget * 0.95
 *  - Chop target: ~20% of budget worth of tokens
 *  - Dropping: `group` commands per contiguous run; `replace { content: "" }` for singles
 *  - State: remembers commands and re-emits them; extends on next trigger
 *
 * This is the dumb baseline — no ranking, no scoring, just oldest-first erasure.
 */
import type { Conductor, ConductorView, Command, ViewBlock } from "../contract";

/** Fraction of budget that triggers a chop. */
const TRIGGER_RATIO = 0.95;
/** Fraction of budget to recover per chop. */
const CHOP_RATIO = 0.20;

/** Kinds the conductor will never target (user intent + durable action records). */
const SKIP_KINDS = new Set(["user", "tool_call"]);

/**
 * Extract the message key from a durable block id — the prefix that all parts of a
 * single assistant message share. Mirrors `engine/ids.ts:messageKey` (two id regimes):
 *  - Live wire: `a:<anchor>:p<j>` / `m<i>:p<j>` → strip the `:p<j>` suffix.
 *  - Loaded transcript: `<eid>:<j>` (numeric suffix) → strip `:<j>`.
 *  - Scalar ids like `u:1234` or `r:<callId>` → returned as-is.
 */
function messageKey(id: string): string {
	const live = id.match(/^(.*):p(?:\d+|\?)$/);
	if (live) return live[1];
	const parsed = id.match(/^(.+):\d+$/);
	if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
	return id;
}

export class SlidingWindowConductor implements Conductor {
	readonly id = "sliding-window";
	readonly label = "Sliding window";

	/** Accumulated commands from all chops so far — re-emitted each call. */
	private _commands: Command[] = [];

	conduct(view: ConductorView): Command[] {
		if (view.budget <= 0 || view.blocks.length === 0) return this._commands;

		// Prune commands referencing blocks that no longer exist in the view.
		this._pruneStale(view);

		const threshold = view.budget * TRIGGER_RATIO;
		// Compute effective live tokens: the raw baseline (host cleared prior pass) minus
		// what our accumulated commands would save. Derived fresh each call from the view —
		// no cumulative counter, so no drift from clamped commands or resync changes.
		const effectiveLive = view.liveTokens - this._estimateSavings(view);

		if (effectiveLive <= threshold) return this._commands;

		const chopTarget = view.budget * CHOP_RATIO;
		this._extendChop(view, chopTarget);
		return this._commands;
	}

	/**
	 * Estimate how many tokens our current commands save by looking up each targeted
	 * block's token cost in the current view. Group digest overhead is ignored (small,
	 * and this is a dumb baseline — slight under-triggering is acceptable).
	 */
	private _estimateSavings(view: ConductorView): number {
		const targeted = this._droppedIds();
		let savings = 0;
		for (const b of view.blocks) {
			if (targeted.has(b.id)) savings += b.tokens;
		}
		return savings;
	}

	/** Remove commands whose block ids no longer exist or are no longer actionable. */
	private _pruneStale(view: ConductorView): void {
		const blocked = new Set<string>();
		const grouped = new Set<string>();
		for (const b of view.blocks) {
			if (b.held || b.protected) blocked.add(b.id);
			if (b.grouped) grouped.add(b.id);
		}
		const existing = new Set(view.blocks.map((b) => b.id));
		this._commands = this._commands.filter((cmd) => {
			if (cmd.kind === "group") return cmd.ids.every((id) => existing.has(id) && !blocked.has(id));
			if (cmd.kind === "replace") return existing.has(cmd.id) && !blocked.has(cmd.id) && !grouped.has(cmd.id);
			return true;
		});
	}

	/**
	 * Walk blocks oldest-first and collect enough to recover `chopTarget` tokens.
	 * Builds group commands per contiguous run, validated against message-boundary
	 * snapping so the host won't reject them. Single isolated blocks use `replace`
	 * with empty content (true erasure, near-zero token cost).
	 */
	private _extendChop(view: ConductorView, chopTarget: number): void {
		const alreadyDropped = this._droppedIds();
		let recovered = 0;

		// Build lookups by message key for blocks that would make group snapping unsafe:
		// (a) held blocks — the host would reject a group that snaps over a held block,
		// (b) SKIP_KINDS blocks (user, tool_call) — snapping would pull them into the
		//     group even though we never targeted them, causing an invalid-group clamp.
		// For (b), fall back to individual `replace` commands instead of grouping.
		const heldMessageKeys = new Set<string>();
		const skipKindsMessageKeys = new Set<string>();
		for (const b of view.blocks) {
			if (b.held) heldMessageKeys.add(messageKey(b.id));
			if (SKIP_KINDS.has(b.kind)) skipKindsMessageKeys.add(messageKey(b.id));
		}

		const eligible = view.blocks.slice(0, view.protectedFromIndex);
		let currentRun: ViewBlock[] = [];

		const flushRun = () => {
			if (currentRun.length === 0) return;

			if (currentRun.length === 1) {
				const b = currentRun[0];
				this._commands.push({ kind: "replace", id: b.id, content: "" });
			} else {
				this._commands.push({
					kind: "group",
					ids: currentRun.map((b) => b.id),
				});
			}
			currentRun = [];
		};

		for (const b of eligible) {
			if (recovered >= chopTarget) {
				flushRun();
				break;
			}

			const isDroppable =
				!SKIP_KINDS.has(b.kind) &&
				!b.protected &&
				!b.held &&
				!b.grouped &&
				!alreadyDropped.has(b.id);

			if (!isDroppable) {
				flushRun();
				continue;
			}

			// Would message-boundary snapping pull in a held block? Skip the whole block.
			if (heldMessageKeys.has(messageKey(b.id))) {
				flushRun();
				continue;
			}

			// Would snapping pull in a SKIP_KINDS block from the same message? The group
			// would be clamped as invalid-group. Fall back to an individual replace so
			// the block is still dropped without triggering the snap.
			if (skipKindsMessageKeys.has(messageKey(b.id))) {
				flushRun();
				this._commands.push({ kind: "replace", id: b.id, content: "" });
				recovered += b.tokens;
				continue;
			}

			currentRun.push(b);
			recovered += b.tokens;
		}

		flushRun();
	}

	/** All block ids currently targeted by our commands. */
	private _droppedIds(): Set<string> {
		const ids = new Set<string>();
		for (const cmd of this._commands) {
			if (cmd.kind === "group") {
				for (const id of cmd.ids) ids.add(id);
			} else if (cmd.kind === "replace") {
				ids.add(cmd.id);
			}
		}
		return ids;
	}
}

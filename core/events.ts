/*
 * events.ts — the FROZEN TruthEvent union.
 *
 * Every state change on a `Truth` instance emits exactly one event, carrying the
 * post-change `rev`. This is the streaming seam: the app's reactive store consumes these to
 * update its `$state` mirror (one `applyTruthEvent` function), and in Phase B the SAME events
 * arrive over the WebSocket from the authoritative Truth in the extension and drive the same
 * function. Design everything host-agnostic.
 */
import type { Block, Actor } from "./types";
import type { LockName } from "./locks";
import type { OpResult } from "./ops";

export type TruthEvent =
	/** New blocks appended to the log (idempotent by id — only genuinely-new blocks appear). */
	| { type: "appended"; blocks: Block[]; rev: number }
	/** An `apply` transaction changed overlay/group state. `results` is the per-op outcome. */
	| { type: "ops-applied"; by: Actor; results: OpResult[]; rev: number }
	/** A config dial moved (budget / contextWindow / protectTokens / calibration). Only the changed
	 *  field(s). `calibration` (v18) is HOST-set only — see `Truth.setCalibration`. */
	| { type: "config"; budget?: number; contextWindow?: number | null; protectTokens?: number; calibration?: number; rev: number }
	/** The involvement lock-set changed (setLocks / clearLocks). */
	| { type: "locks"; locks: readonly LockName[]; holder: string | null; tailTokens: number; rev: number }
	/** The sent cursor advanced (a plan actually reached the model). */
	| { type: "sent"; throughOrder: number; rev: number }
	/** A wholesale reset — every override + strategy fold cleared, all groups dropped. */
	| { type: "reset"; rev: number };

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
	/** A config dial moved (budget / contextWindow / protectTokens / calibration / systemPrompt). Only
	 *  the changed field(s). `calibration` (v18) is HOST-set only — see `Truth.setCalibration`.
	 *  `systemPrompt` (v19, issue #93) is HOST-set only — see `Truth.setSystemPrompt`. Since v22 the
	 *  prompt is a real BOLTED `system` BLOCK rather than a scalar, but the event stays on `config`:
	 *  it is the replayable INPUT a replica turns into a create-or-replace of its own system block
	 *  (an `appended` event can express neither a replace nor a head insertion).
	 *  `systemPromptCalibrated` remains separate from the ordinary order frontier because the prompt
	 *  can be replaced in place at order -1 after the latest receipt. */
	| {
			type: "config";
			budget?: number;
			contextWindow?: number | null;
			protectTokens?: number;
			calibration?: number;
			calibrationThroughOrder?: number;
			systemPromptCalibrated?: boolean;
			systemPrompt?: { text: string; tokens: number };
			rev: number;
	  }
	/** The involvement lock-set changed (setLocks / clearLocks). */
	| { type: "locks"; locks: readonly LockName[]; holder: string | null; tailTokens: number; rev: number }
	/** The sent cursor advanced (a plan actually reached the model). */
	| { type: "sent"; throughOrder: number; rev: number }
	/** A wholesale reset — every override + strategy fold cleared, all groups dropped. */
	| { type: "reset"; rev: number };

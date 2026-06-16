/*
 * compaction-naive.ts — the "Naive compaction" conductor.
 *
 * PURPOSE: This conductor exists as a deliberate BASELINE / FOIL that demonstrates
 * what mainstream AI coding tools do today. When the context approaches capacity,
 * it calls an LLM to summarize the aged history into a single prose blob and presents
 * the agent the summary instead of the real conversation history.
 *
 * It is DELIBERATELY LOSSY AND RECURSIVE:
 *   - Lossy: the original blocks are replaced by a generated summary. The agent cannot
 *     recover the originals (no {#code FOLDED} tag → no self-unfold). From the agent's
 *     perspective, the history is gone — faithfully reproducing the behaviour of tools
 *     like Cursor's composer or Claude Code's own /compact command.
 *   - Recursive: each subsequent compaction summarizes the PRIOR SUMMARY + newly aged
 *     blocks. It never re-reads the original blocks already compressed. This self-imposed
 *     amnesia compounds quality loss over a session — exactly the failure mode Accordion's
 *     reversible folding is designed to avoid.
 *
 * The human can always DETACH this conductor to recover full history — that's Accordion
 * being Accordion — but the agent cannot. That asymmetry is the whole point.
 *
 * TOOL_CALL SAFETY: this conductor never emits a `replace` targeting a `tool_call` block.
 * `tool_call` blocks are excluded from the aged region entirely — they are left live and
 * untouched. This matches the engine's "tool_call is never folded" invariant and keeps the
 * outgoing message provider-valid. The host's `substOne` has NO kind-check and would apply
 * a `replace` to a `tool_call` verbatim, so the conductor must not emit one.
 *
 * No Svelte, no $state, no engine imports. Types only from ../contract.
 */

import type {
	Conductor,
	ConductorHost,
	ConductorView,
	ViewBlock,
	Command,
} from "../contract";

/** Soft cap on summary output tokens. The host may clamp further. */
const MAX_SUMMARY_TOKENS = 1500;

/**
 * System prompt for the compaction LLM call. Industry-standard template asking for a
 * structured summary that preserves the most important signals for the agent continuing
 * the conversation.
 */
const COMPACTION_SYSTEM = `\
You are a context-compaction assistant. Your job is to summarize a segment of an AI \
assistant's conversation history into a compact, structured briefing that the assistant \
can use to continue working effectively without seeing the original messages.

Produce your output in EXACTLY this structure — no prose outside the sections, no \
omissions:

## Goal
One sentence: what is the overall task or objective being pursued?

## Progress
Bullet list of what has been accomplished so far. Be specific: files changed, commands \
run, decisions made, errors encountered and resolved.

## Key decisions
Bullet list of the important choices made (architecture, approach, libraries, \
workarounds). Include the reasoning where it matters for future steps.

## Next steps
Bullet list of what is expected to happen next, in the order the work is heading.

## Critical context
Any facts, invariants, or constraints the assistant MUST remember: API keys pattern \
(never actual values), file paths, environment quirks, non-obvious rules from the \
human's instructions, hard constraints on scope. Err on the side of including \
something here if it would be surprising to lose it.

Be terse. Every sentence should earn its place. Omit pleasantries, meta-commentary, \
and filler. The output will be placed directly into the agent's context window.`;

export class NaiveCompactionConductor implements Conductor {
	readonly id = "compaction-naive";
	readonly label = "Naive compaction";

	// ── instance state ─────────────────────────────────────────────────────────

	/** Injected by init(); null until the conductor is attached. */
	private host: ConductorHost | null = null;

	/** The current compaction summary text. Null until the first summary completes. */
	private summary: string | null = null;

	/**
	 * The block ids currently represented by the summary. Includes the head block
	 * (which CARRIES the summary text) and all other aged blocks emptied behind it.
	 * Empty until the first summary completes.
	 */
	private compactedIds: Set<string> = new Set();

	// ── in-flight tracking ─────────────────────────────────────────────────────

	/** AbortController for the current in-flight completion, or null when idle. */
	private inflight: AbortController | null = null;

	/**
	 * A stable key representing the NEWLY AGED block set we most recently ATTEMPTED to
	 * summarize (launched a completion for). Used to prevent re-launching the exact
	 * same newly-aged set after a rejected/failed completion.
	 *
	 * Keyed on `newlyAged` ids (NOT the full aged set) so that a pure SHRINK of the
	 * aged set (e.g. a human pins an old block, removing it from consideration) does NOT
	 * change this key and does NOT re-launch — nothing genuinely new aged in.
	 * A genuinely new aged block DOES change the key (new id joins newlyAged) and
	 * correctly allows a retry.
	 *
	 * Set when a completion is launched; NOT cleared on rejection. Cleared implicitly on
	 * success — after success, `compactedIds` grows to cover the set, making `newlyAged`
	 * empty, so the attempt key is irrelevant.
	 */
	private lastAttemptKey: string = "";

	// ── lifecycle ──────────────────────────────────────────────────────────────

	init(host: ConductorHost): void {
		this.host = host;
	}

	dispose(): void {
		// Cancel any in-flight completion so stale results don't call invalidate()
		// after the conductor is detached.
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.host = null;
	}

	// ── main conduct loop ─────────────────────────────────────────────────────

	conduct(view: ConductorView): Command[] | null {
		// Cannot operate without a host (e.g. headless test without init).
		if (!this.host) return null;

		// The THRESHOLD at which compaction is triggered: 95 % of the token budget.
		const threshold = 0.95 * view.budget;

		// AGED REGION: blocks eligible to compact = older than the protected working tail,
		// not human-held, not already inside a conductor group, and NOT tool_call.
		//
		// tool_call blocks are excluded because the host's substOne has NO kind-check and
		// would apply a replace verbatim — emptying a tool_call would violate the engine's
		// "tool_call is never folded → never orphans its result" invariant. The conductor
		// itself enforces this; the host will not protect us.
		const agedBlocks: ViewBlock[] = [];
		for (let i = 0; i < view.protectedFromIndex && i < view.blocks.length; i++) {
			const b = view.blocks[i];
			if (!b.held && !b.grouped && b.kind !== "tool_call") agedBlocks.push(b);
		}

		// If there is nothing aged and no prior summary, nothing to do — return raw.
		if (agedBlocks.length === 0 && this.summary === null) return [];

		// If a completion is in-flight, hold the current state — never launch a second.
		if (this.inflight !== null) return this.buildCommands(view);

		// Determine what is genuinely new since the last successful compaction.
		const newlyAged: ViewBlock[] = agedBlocks.filter((b) => !this.compactedIds.has(b.id));

		// Decide whether to (re)summarize:
		// trigger only when >= 95% full AND there are newly aged blocks to fold in.
		const needSummary = view.liveTokens >= threshold && newlyAged.length > 0;

		if (!needSummary) {
			// Conductor has a definite synchronous answer: nothing to compact right now.
			// Return the existing summary commands if we have one; otherwise clear to raw.
			// Do NOT return null here — null means "still thinking / in-flight", which
			// is false: we have a definite answer.
			return this.summary !== null ? this.buildCommands(view) : [];
		}

		// DEGRADE path: if the host cannot run completions (live model not connected),
		// fall back to a deterministic `group` command over the contiguous aged run.
		// This is visually useful (collapses the aged region into a host-generated digest)
		// without requiring a model call, and lets the conductor still be attached in
		// read-only / transcript sessions.
		if (!this.host.can("complete")) {
			// group requires ≥ 2 aged survivor blocks that form a clean contiguous ungrouped run.
			// If there is a pre-existing group interleaved in the aged region, the host's outward
			// snap would make the group command invalid → `invalid-group` clamp → silent no-op.
			// To avoid producing a false degrade, only emit the group when the aged survivors
			// form a clean run (no interleaved grouped blocks in the aged region).
			//
			// Limitation: we approximate "clean run" as no grouped blocks in the age region at all.
			// (agedBlocks already excludes grouped blocks; if ANY block between first and last
			// aged survivor IS grouped, the host's snap would sweep it in and clamp → we bail.)
			if (agedBlocks.length < 2) return this.summary !== null ? this.buildCommands(view) : [];

			// Check if there are any grouped blocks sitting between the first and last aged block
			// in conversation order. Those would be swept into the host's outward snap and cause
			// an invalid-group clamp.
			const firstIdx = view.blocks.indexOf(agedBlocks[0]);
			const lastIdx = view.blocks.indexOf(agedBlocks[agedBlocks.length - 1]);
			let hasInterleaved = false;
			for (let i = firstIdx; i <= lastIdx; i++) {
				if (view.blocks[i].grouped) {
					hasInterleaved = true;
					break;
				}
			}
			if (hasInterleaved) {
				// Can't form a clean group — bail rather than emit a clamp-destined command.
				return this.summary !== null ? this.buildCommands(view) : [];
			}

			const firstId = agedBlocks[0].id;
			const lastId = agedBlocks[agedBlocks.length - 1].id;
			return [{ kind: "group", ids: [firstId, lastId] }];
		}

		// FIX 3: Gate the launch on a stable signature of the NEWLY AGED set being attempted
		// (not the full aged set). This prevents:
		//   - Re-launching after rejection on the same newly-aged set (unchanged → same key).
		//   - Re-launching when the aged set SHRINKS (e.g. human pins old block) — a shrink
		//     does NOT change newlyAged ids, so the key is unchanged → no wasteful re-launch.
		// A genuinely new aged block changes newlyAged → new key → retry is allowed.
		const attemptKey = [...newlyAged.map((b) => b.id)].sort().join("\0");
		if (attemptKey === this.lastAttemptKey) {
			// Same newly-aged set as the last (failed) attempt — hold current state.
			return this.summary !== null ? this.buildCommands(view) : [];
		}

		// LAUNCH a background completion. Snapshot the aged ids NOW so the
		// async resolve handler uses the state it summarized, not a later view.
		this.launchCompletion(agedBlocks, newlyAged, attemptKey);

		// Return prior commands (hold existing summary) while the new one is in-flight.
		// On the very first trip there is no prior summary, so return null — this is the
		// ONE correct use of null: a completion IS in-flight and there is no prior state
		// to hold (genuinely still thinking; nothing applied yet).
		return this.buildCommands(view);
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	/**
	 * Build and return the current desired command set, VALIDATED against the live view.
	 *
	 * FIX 1 (DATA-LOSS BLOCKER): the prior implementation re-emitted commands from stale
	 * cached instance state (`headId`, `compactedIds`) without checking whether those ids
	 * still exist in the current view. If the head block vanished (resync, truncation), the
	 * head replace was clamped/skipped — but the empty replaces for other compacted ids were
	 * still applied VERBATIM, destroying content with no recovery path.
	 *
	 * This method re-derives the command set from the LIVE view on every call:
	 *   1. Compute SURVIVING compacted blocks = ids in compactedIds that still exist in
	 *      view.blocks AND are not held, not grouped, not protected.
	 *   2. Choose head = surviving block with the LOWEST order (oldest surviving). If the
	 *      original head vanished, the summary re-homes to the next oldest survivor.
	 *   3. If NO survivor qualifies as head → return [] (clear to raw). No empties emitted,
	 *      no data loss — the host resets all blocks to full live content this pass.
	 *   4. Otherwise return [ replace(head, summary), ...replace(other, "") per other survivor ].
	 *
	 * INVARIANT: this method NEVER returns an array containing replace(x,"") unless it also
	 * contains replace(head, summary) on a block present in the current view.
	 *
	 * Returns:
	 *   - null  → no summary yet; used ONLY while a first-trip completion is in-flight
	 *             (the ONE correct use of null: still thinking, nothing applied yet).
	 *   - []    → no surviving compacted blocks to re-apply (clear to raw; lossless).
	 *   - [...] → head replace (summary text) + one empty replace per other surviving id.
	 */
	private buildCommands(view: ConductorView): Command[] | null {
		if (this.summary === null) return null;

		// Build an id→block lookup for the current view.
		const blockById = new Map<string, ViewBlock>(view.blocks.map((b) => [b.id, b]));

		// Compute surviving compacted blocks: present in view, not held/grouped/protected.
		// (Protected blocks in compactedIds means the summary grew over them — the host
		// would clamp a replace on them with reason "protected", which is just log spam.
		// Exclude them here so we never emit stale commands that generate clamp noise.)
		const survivors: ViewBlock[] = [];
		for (const id of this.compactedIds) {
			const b = blockById.get(id);
			if (b && !b.held && !b.grouped && !b.protected) {
				survivors.push(b);
			}
		}

		// No survivors → the entire compacted set vanished/is protected/grouped. Clear to raw.
		// Returning [] is LOSSLESS: the host resets all blocks to full live content this pass.
		// The summary text is preserved in this.summary in case a future view re-exposes blocks.
		if (survivors.length === 0) return [];

		// Choose head = block with the lowest order (oldest surviving compacted block).
		// sort() is non-mutating-friendly since survivors is a local array.
		survivors.sort((a, b) => a.order - b.order);
		const head = survivors[0];

		const cmds: Command[] = [];

		// The head block carries the summary text.
		cmds.push({ kind: "replace", id: head.id, content: this.summary });

		// Every other surviving compacted block is emptied — it stays structurally in
		// place (tool-call/result pairing is intact) but contributes (almost) nothing
		// to the token count.
		// NOTE: tool_call blocks are never in compactedIds (excluded from agedBlocks at
		// collection time), so we can never accidentally empty a tool_call here.
		for (const b of survivors) {
			if (b.id === head.id) continue;
			cmds.push({ kind: "replace", id: b.id, content: "" });
		}

		return cmds;
	}

	/**
	 * Fire-and-forget: build the compaction prompt and launch a host.complete() call.
	 * conduct() returns immediately after calling this; the result comes back via the
	 * resolve handler which calls host.invalidate() to schedule a fresh conduct() pass.
	 *
	 * @param agedBlocks - all aged blocks at launch time (SNAPSHOT — don't use the view later).
	 * @param newlyAged  - subset not already in compactedIds (used to build the recursive prompt).
	 * @param attemptKey - the sorted-join key of the NEWLY AGED set being attempted; stored to
	 *                     prevent re-launching the same newly-aged set after a rejection.
	 */
	private launchCompletion(agedBlocks: ViewBlock[], newlyAged: ViewBlock[], attemptKey: string): void {
		// Safety: should never reach here while inflight, but guard defensively.
		if (this.inflight !== null) return;

		// Snapshot the ids and count at LAUNCH TIME. The resolve handler closes over these
		// so it applies the summary to exactly the blocks it summarized, regardless of
		// what the view looks like when it resolves.
		const launchedAgedIds = new Set(agedBlocks.map((b) => b.id));
		const count = agedBlocks.length;

		// Build the user-role prompt.
		const prompt = this.buildPrompt(newlyAged);

		// Record the attempt key (keyed on newlyAged ids) so that a rejected completion
		// does NOT immediately re-launch for the same newly-aged set on the next conduct() tick.
		// This key is NOT cleared on rejection — an unchanged newly-aged set stays suppressed.
		// It IS superseded automatically when newlyAged grows (new key ≠ old key).
		this.lastAttemptKey = attemptKey;

		const controller = new AbortController();
		this.inflight = controller;

		this.host!.complete({
			system: COMPACTION_SYSTEM,
			prompt,
			maxOutputTokens: MAX_SUMMARY_TOKENS,
			signal: controller.signal,
		}).then(
			(result) => {
				// Success: commit the new summary and command state.
				// NOTE: we do NOT store a headId — buildCommands() re-derives the head from
				// the live view every call, so it is always valid even if blocks shift.
				this.inflight = null;
				this.summary =
					`[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n` +
					result.text;
				this.compactedIds = launchedAgedIds;
				// Ask the host to re-run conduct() now so the replace commands take effect
				// immediately rather than waiting for the next natural context change.
				this.host?.invalidate();
			},
			(_err) => {
				// Rejected (abort, network error, unknown model, etc.): clear inflight but
				// leave prior summary/state intact. We do NOT immediately relaunch — the
				// lastAttemptKey guard ensures we only retry when genuinely new aged content
				// arrives (changing the attempt key) or when the conductor is replaced on
				// the next attach. This prevents a tight model-hammering loop on a
				// persistent failure.
				this.inflight = null;
				// Note: if this.host is null here, dispose() was called mid-flight — that
				// is fine, the abort() in dispose() will cause the reject branch, and we
				// simply clear inflight and exit.
			},
		);
	}

	/**
	 * Build the user-role prompt for the compaction completion.
	 *
	 * FIRST compaction (summary == null):
	 *   Concatenate the text of ALL aged-region blocks, labeled by role/kind.
	 *   Every block that has ever been aged is included verbatim.
	 *
	 * RECURSIVE compaction (summary != null):
	 *   Prepend the PRIOR SUMMARY, then append only the NEWLY AGED blocks.
	 *   The originals already compressed into the prior summary are DELIBERATELY NOT
	 *   re-read — this recursive amnesia is the entire point of the baseline: it
	 *   faithfully reproduces the compounding quality loss that mainstream tools
	 *   impose (each compaction can only see the previous summary, not the originals).
	 *   Accordion's reversible folding does not have this problem — that is why this
	 *   conductor exists as a foil.
	 */
	private buildPrompt(newlyAged: ViewBlock[]): string {
		const parts: string[] = [];

		if (this.summary !== null) {
			// Recursive path: start from the prior summary (already amnesiac).
			parts.push("=== PRIOR SUMMARY (previous compaction output) ===");
			parts.push(this.summary);
			parts.push("");
			parts.push("=== NEWLY ADDED MESSAGES (append to the above) ===");
		} else {
			// First compaction: label the section for the model.
			parts.push("=== CONVERSATION HISTORY TO SUMMARIZE ===");
		}

		for (const b of newlyAged) {
			const label = blockLabel(b);
			const text = (b.text ?? "").trim();
			parts.push(`[${label}]`);
			if (text) parts.push(text);
			parts.push("");
		}

		return parts.join("\n");
	}
}

// ── utilities ─────────────────────────────────────────────────────────────────

/**
 * A short human-readable label for a block, used when building the compaction prompt.
 * Mirrors the role labeling convention in the Transcript view.
 */
function blockLabel(b: ViewBlock): string {
	switch (b.kind) {
		case "user":
			return "user";
		case "text":
			return "assistant";
		case "thinking":
			return "assistant thinking";
		case "tool_call":
			return b.toolName ? `tool call: ${b.toolName}` : "tool call";
		case "tool_result":
			return b.toolName ? `tool result: ${b.toolName}` : "tool result";
		default: {
			// Exhaustive check — TypeScript will error here if a new kind is added
			// to ConductorBlockKind without updating this switch.
			const _never: never = b.kind;
			return String(_never);
		}
	}
}

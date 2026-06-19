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
 * REPLACE-TARGET SAFETY: this conductor only emits `replace` commands for block kinds the
 * host can actually represent on the wire (`text`, `thinking`, and `tool_result`). The host
 * is still the final safety net — it clamps non-foldable `user`/`tool_call` targets with
 * `not-foldable` — but relying on that clamp would break this conductor's own invariant: the
 * summary must land on a valid head before any other block is emptied. Non-foldable blocks
 * therefore stay live and are never command targets.
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

/**
 * Soft cap on summary output tokens.
 *
 * Sized for the job: this conductor compacts roughly 20k–200k tokens of aged history at a
 * time, so the briefing needs room to retain the important signals — 1.5k was far too tight.
 * 8k still represents a large reduction (~2.5x at 20k of input, ~25x at 200k) while leaving
 * a useful structured summary.
 *
 * The extension clamps the requested max to the model's own max-output ceiling before
 * sending the API call, and the model enforces it as a hard generation cap — so requesting
 * more than a given model allows is safe (it is clamped, not rejected). If the summary would
 * exceed the (clamped) ceiling, the output is TRUNCATED (finish-reason "length") and used
 * as-is — acceptable for a lossy baseline.
 */
const MAX_SUMMARY_TOKENS = 8000;

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

	/**
	 * Involvement locks (ADR 0011). This conductor takes EXCLUSIVE control of the two
	 * STEERING controls — the human's hand fold/unfold/pin/group/reset and the agent's
	 * `unfold` tool — so the user, the agent, and the conductor cannot fight over the same
	 * blocks while a compaction pass is replacing them. Naive compaction reasons over a
	 * deterministic aged region and rewrites it in place; a stray human unfold or agent
	 * unfold mid-pass would desync its `compactedIds`/`summary` state from the live view.
	 * Locking those two domains gives it the deterministic world the foil needs.
	 *
	 * It deliberately does NOT lock `tail-size`. Under that lock the host sets
	 * `protectedFromIndex = view.blocks.length` (no host tail floor), which would make the
	 * aged-region scan (`i < view.protectedFromIndex`) cover the WHOLE conversation — the
	 * conductor would then compact the agent's live working tail. Mainstream compaction keeps
	 * recent turns verbatim, so this conductor relies on the host's protected tail and leaves
	 * `tail-size` unlocked: the human may still resize the tail (it merely reshapes the aged
	 * region the conductor deterministically obeys), but cannot reach into the compacted blocks.
	 * Edge: a human who drags the tail to 0 has explicitly opted out of a protected tail, so the
	 * aged region then extends to the newest turn and compaction may summarize recent reasoning —
	 * that is the human's own setting being honored, not a fight the conductor loses.
	 *
	 * Note on `agent-unfold`: because this conductor uses `replace` (no `{#code FOLDED}` tags),
	 * the agent never has a fold code for a compacted block — so it could not `unfold` (or even
	 * `recall`) one regardless. The lock is the honest declaration of intent ("the agent does
	 * not steer here") and future-proofs against the agent unfolding any OTHER folded block.
	 */
	readonly locks = ["human-steering", "agent-unfold"] as const;

	// ── instance state ─────────────────────────────────────────────────────────

	/** Injected by attach(); null until the conductor is attached. */
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

	attach(host: ConductorHost): void {
		// A conductor lifetime starts fresh on attach. The common UI path creates a new instance,
		// but the contract allows re-attaching the same instance; do not let a summary or retry key
		// from a prior session leak into the next one.
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.summary = null;
		this.compactedIds = new Set();
		this.lastAttemptKey = "";
		this.host = host;
	}

	detach(): void {
		// Cancel any in-flight completion so stale results don't call requestRerun()
		// after the conductor is detached.
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.host?.setStatus(null);
		this.host = null;
	}

	// ── main conduct loop ─────────────────────────────────────────────────────

	conduct(view: ConductorView): Command[] | null {
		// Cannot operate without a host (e.g. headless test without attach).
		if (!this.host) return null;

		// The THRESHOLD at which compaction is triggered: 95 % of the token budget.
		const threshold = 0.95 * view.budget;

		// AGED REGION: blocks eligible to summarize = older than the protected working tail,
		// not human-held, not already inside a conductor group, and NOT tool_call. `tool_call`
		// stays live so a tool invocation is never summarized away from its result. `user` blocks
		// may be included in the prompt for context, but buildCommands() will never target them
		// with `replace` because the host cannot represent per-block folds for user intent.
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
		const newlyReplaceable = newlyAged.filter(isReplaceableByHost);

		// Decide whether to (re)summarize:
		// trigger only when >= 95% full AND there are newly aged blocks the host can actually
		// replace/fold. Non-foldable `user` blocks may provide prompt context when a foldable
		// neighbour ages with them, but they should not by themselves burn a completion call.
		const needSummary = view.liveTokens >= threshold && newlyReplaceable.length > 0;

		if (!needSummary) {
			this.host.setStatus(null);
			// Conductor has a definite synchronous answer: nothing to compact right now.
			// Return the existing summary commands if we have one; otherwise clear to raw.
			// Do NOT return null here — null means "still thinking / in-flight", which
			// is false: we have a definite answer.
			return this.summary !== null ? this.buildCommands(view) : [];
		}

		// DEGRADE path: if the host cannot run completions (live model not connected),
		// report unavailability by preserving the current state.
		// No deterministic grouping fallback: this conductor is specifically the LLM-summary
		// baseline, so if the host cannot complete we wait visibly rather than silently
		// switching strategies.
		if (!this.host.can("complete")) {
			this.host.setStatus("Naive compaction unavailable — waiting for live model link", {
				aged: agedBlocks.length,
				fullness: Math.round((view.liveTokens / view.budget) * 100),
			});
			return this.summary !== null ? this.buildCommands(view) : [];
		}
		this.host.setStatus(null);

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

		// Hold while the completion is in-flight: re-emit via buildCommands(view), which returns
		// the existing summary's commands if one is already applied, or null on the very first
		// trip (no prior summary yet — the ONE correct use of null: genuinely still thinking,
		// nothing applied). Either way the in-flight completion is not relaunched.
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
	 *   2. Keep only host-replaceable survivors (`text`, `thinking`, `tool_result`) as command
	 *      targets. `user`/`tool_call` blocks stay live: the host would clamp them with
	 *      `not-foldable`, so using one as the summary head would discard the summary while
	 *      still allowing other empty replaces to apply.
	 *   3. Choose head = replaceable survivor with the LOWEST order (oldest surviving). If the
	 *      original head vanished or is non-foldable, the summary re-homes to the next oldest
	 *      replaceable survivor.
	 *   4. If NO replaceable survivor qualifies as head → return [] (clear to raw). No empties emitted,
	 *      no data loss — the host resets all blocks to full live content this pass.
	 *   5. Otherwise return [ replace(head, summary), ...replace(other, "") per other replaceable survivor ].
	 *
	 * INVARIANT: this method NEVER returns an array containing replace(x,"") unless it also
	 * contains replace(head, summary) on a host-replaceable block present in the current view.
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

		// Only replace kinds that the host can represent on the wire. If the oldest survivor is
		// a `user` block, replacing it would be clamped `not-foldable`; any empty replaces for
		// the other survivors would still apply, dropping the summary. Re-home the head to the
		// oldest replaceable survivor instead.
		const replaceable = survivors.filter(isReplaceableByHost);
		if (replaceable.length === 0) return [];

		// Choose head = replaceable block with the lowest order (oldest valid target).
		// sort() is non-mutating-friendly since replaceable is a local array.
		replaceable.sort((a, b) => a.order - b.order);
		const head = replaceable[0];

		const cmds: Command[] = [];

		// The head block carries the summary text.
		cmds.push({ kind: "replace", id: head.id, content: this.summary });

		// Every other replaceable surviving compacted block is emptied — it stays structurally in
		// place (tool-call/result pairing is intact) but contributes (almost) nothing
		// to the token count.
		// Non-foldable survivors (user/tool_call) are deliberately left live.
		for (const b of replaceable) {
			if (b.id === head.id) continue;
			cmds.push({ kind: "replace", id: b.id, content: "" });
		}

		return cmds;
	}

	/**
	 * Fire-and-forget: build the compaction prompt and launch a host.complete() call.
	 * conduct() returns immediately after calling this; the result comes back via the
	 * resolve handler which calls host.requestRerun() to schedule a fresh conduct() pass.
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
				const text = result.text.trim();
				if (!text) {
					// Empty output would replace the aged context with only the boilerplate header.
					// Treat it as a failed attempt: preserve the prior summary/state and wait for
					// genuinely new aged content before retrying this same key.
					this.inflight = null;
					this.host?.setStatus("Naive compaction failed — model returned an empty summary", {
						aged: count,
					});
					return;
				}
				// Success: commit the new summary and command state.
				// NOTE: we do NOT store a headId — buildCommands() re-derives the head from
				// the live view every call, so it is always valid even if blocks shift.
				this.inflight = null;
				this.summary =
					`[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n` +
					text;
				this.compactedIds = launchedAgedIds;
				// Ask the host to re-run conduct() now so the replace commands take effect
				// immediately rather than waiting for the next natural context change.
				this.host?.requestRerun();
			},
			(_err) => {
				// Rejected (abort, network error, unknown model, etc.): clear inflight but
				// leave prior summary/state intact. We do NOT immediately relaunch — the
				// lastAttemptKey guard ensures we only retry when genuinely new aged content
				// arrives (changing the attempt key) or when the conductor is replaced on
				// the next attach. This prevents a tight model-hammering loop on a
				// persistent failure.
				this.inflight = null;
				// Note: if this.host is null here, detach() was called mid-flight — that
				// is fine, the abort() in detach() will cause the reject branch, and we
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

/** Block kinds the host can fold/replace as individual wire content substitutions. */
function isReplaceableByHost(b: ViewBlock): boolean {
	return b.kind === "text" || b.kind === "thinking" || b.kind === "tool_result";
}

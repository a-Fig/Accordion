/*
 * compaction-naive.ts — the "Naive compaction" conductor.
 *
 * PURPOSE: This conductor exists as a deliberate BASELINE / FOIL that demonstrates
 * what mainstream AI coding tools do today. When the context approaches capacity,
 * it calls an LLM to summarize the aged history into a single prose summary and
 * presents the agent that one summary IN PLACE of the whole aged region — faithfully
 * reproducing what Cursor's composer, Claude Code's `/compact`, and similar tools do.
 *
 * It is DELIBERATELY LOSSY AND RECURSIVE:
 *   - Lossy: the aged blocks are collapsed into ONE group whose digest is the generated
 *     summary. There is no `{#code FOLDED}` tag on the summary, so the agent cannot call
 *     `unfold` to recover the originals. From the agent's perspective the history is gone
 *     — exactly the mainstream-tool behaviour. The human can always DETACH this conductor
 *     to recover full history (that is Accordion being Accordion), but the agent cannot.
 *     That asymmetry is the whole point.
 *   - Recursive: each subsequent compaction summarizes the PRIOR SUMMARY + only the
 *     newly aged blocks. It never re-reads the originals already compressed. This
 *     self-imposed amnesia compounds quality loss over a session — the exact failure
 *     mode Accordion's reversible folding is designed to avoid.
 *
 * SHAPE — close cousin of the sliding-window conductor. Where sliding-window emits
 * `group(digest: null)` (DROP the aged run from the wire) to keep a live window, this
 * conductor emits `group(digest: <LLM summary>)` (REPLACE the aged run with one summary
 * message). Same single-group-over-the-aged-run shape; only the digest differs. The host
 * snaps the run outward to whole messages and pair-balances `tool_call`/`tool_result`,
 * so no tool result is ever orphaned.
 *
 * TRIGGER — sliding-window-style hysteresis. `view.liveTokens` is the RAW, fully-unfolded
 * size (the host clears conductor folds before every pass), so it only grows; a naive
 * `liveTokens >= 90%` test would re-trigger on every pass once first crossed. Instead the
 * conductor tracks the token SAVING its summary group provides and triggers on the VISIBLE
 * window: `visible = liveTokens − (Σ survivor tokens − summary token cost)`. When
 * `visible >= 90%` of budget AND there are newly-aged blocks to fold in, it launches a
 * completion; otherwise it HOLDS, re-emitting the existing summary group. Compacting the
 * newly-aged blocks drops `visible` well below 90%, and the conductor waits for the window
 * to refill before acting again — the same high-water band sliding-window uses.
 *
 * AMNESIA / MONOTONIC COVER. `compactedIds` is the monotonic set of block ids already
 * represented by the summary (the sliding-window `dropped` set's analog — only ever grows
 * within a session). At trigger the conductor feeds the LLM `prior summary + newly-aged
 * originals` only; the originals already compressed are deliberately not re-read. The
 * summary group covers `compactedIds ∩ aged region` — the oldest aged blocks, which (because
 * blocks age in order and `human-steering` keeps the region contiguous) form a single
 * contiguous run → one group, one summary tile.
 *
 * USER MESSAGES ARE PRESERVED VERBATIM inside the summary (Claude-Code `/compact`
 * behaviour): the system prompt instructs the model to reproduce every user message
 * word-for-word in a dedicated section. `user` intent therefore survives compaction
 * intact across the whole session; only assistant reasoning degrades — the faithful foil.
 *
 * All block kinds (`user`, `text`, `thinking`, `tool_call`, `tool_result`) are swallowed
 * by the group. The host's whole-message snap + pair-balance keeps the result wire-valid.
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

/** Fraction of budget at which compaction triggers (high-water mark). */
const TRIGGER = 0.9;

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
 * System prompt for the compaction LLM call. Industry-standard structured-briefing template
 * (pi, OpenCode, and Claude Code `/compact` all converge on a near-identical shape), with
 * one sacred rule lifted from Claude Code's `/compact`: user messages are reproduced
 * VERBATIM so the human's intent and instructions survive every compaction intact. Only
 * assistant text/thinking/tool calls/tool results are summarized.
 *
 * The prompt is the FAITHFUL FOIL's voice, so it mirrors what real tools actually do
 * rather than over- or under-specifying:
 *   - A "do NOT continue the conversation" guard (pi's `SUMMARIZATION_SYSTEM_PROMPT`) —
 *     this prevents a non-compaction failure mode (the model answering the conversation
 *     instead of summarizing it); it does NOT reduce the recursive-amnesia loss the foil
 *     is built to demonstrate.
 *   - A `## Relevant files` section (OpenCode has this; pi tracks files via XML tags).
 *     File paths are the #1 artifact lost in recursive compaction, and real tools retain
 *     them, so the foil does too — yet they still degrade across recursive passes because
 *     the model re-summarizes them from the prior summary, never the originals.
 *   - The "(none)" placeholder convention (OpenCode) keeps the structure parseable even
 *     when a section is empty.
 *
 * The format spec lives in the SYSTEM prompt (not the user prompt) because it is identical
 * for the first and recursive passes; only the user-prompt preamble differs (see
 * `buildPrompt`), which carries the recursive merge instructions.
 */
const COMPACTION_SYSTEM = `\
You are a context-compaction assistant. Your task is to read a segment of an AI \
assistant's conversation history and produce a compact, structured briefing that the \
assistant can use to continue working effectively without seeing the original messages.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. \
ONLY output the structured summary.

USER MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM, in order, exactly as \
originally written, in the "## User messages" section. Do not paraphrase, abbreviate, \
summarize, or omit a single user message — the human's intent and instructions must \
survive compaction intact. (Assistant text, thinking, tool calls, and tool results ARE \
summarized; only user messages are preserved word-for-word.)

Produce your output in EXACTLY this structure — no prose outside the sections. Keep \
every section even when empty; write "(none)" where nothing applies:

## User messages
Every user message from the summarized segment, reproduced verbatim, in order, each \
clearly separated. If there are no user messages, write "(none)".

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

## Relevant files
- {file path}: why it matters. List files that were read, written, or are central to \
the task. Write "(none)" if none.

Be terse everywhere EXCEPT the verbatim user messages, which must be complete. Omit \
pleasantries, meta-commentary, and filler. The output will be placed directly into the \
agent's context window.`;

export class NaiveCompactionConductor implements Conductor {
	readonly id = "compaction-naive";
	readonly label = "Naive compaction";

	/**
	 * Involvement locks (ADR 0011). This conductor takes EXCLUSIVE control of the two
	 * STEERING controls — the human's hand fold/unfold/pin/group/reset and the agent's
	 * `unfold` tool — so the user, the agent, and the conductor cannot fight over the same
	 * blocks while a compaction pass is rewriting them. `human-steering` is load-bearing for
	 * the single-group shape: under that lock the human cannot pin or group a block inside
	 * the aged region, so the region stays CONTIGUOUS and the one `group` command covering
	 * it is always valid (the host refuses a run that spans a human-held block). Dropping the
	 * lock would let a held block split the region, fragmenting the single summary tile.
	 *
	 * It deliberately does NOT lock `tail-size`. Under that lock the host sets
	 * `protectedFromIndex = view.blocks.length` (no host tail floor), which would make the
	 * aged region cover the WHOLE conversation — the conductor would compact the agent's live
	 * working tail. Mainstream compaction keeps recent turns verbatim, so this conductor
	 * relies on the host's protected tail and leaves `tail-size` unlocked: the human may still
	 * resize the tail (it merely reshapes the aged region the conductor obeys), but cannot
	 * reach into the compacted blocks. Edge: a human who drags the tail to 0 has explicitly
	 * opted out of a protected tail, so the aged region then extends to the newest turn and
	 * compaction may summarize recent reasoning — that is the human's own setting being
	 * honored, not a fight the conductor loses.
	 *
	 * Note on `agent-unfold`: because this conductor emits a `group` (no `{#code FOLDED}`
	 * tags), the agent never has a fold code for a compacted block — so it could not `unfold`
	 * (or even `recall`) one regardless. The lock is the honest declaration of intent ("the
	 * agent does not steer here") and future-proofs against the agent unfolding any OTHER
	 * folded block.
	 */
	readonly locks = ["human-steering", "agent-unfold"] as const;

	// ── instance state ─────────────────────────────────────────────────────────

	/** Injected by attach(); null until the conductor is attached. */
	private host: ConductorHost | null = null;

	/** The current compaction summary text (with its count preamble). Null until the first summary completes. */
	private summary: string | null = null;

	/**
	 * The block ids currently represented by the summary — the monotonic "already
	 * summarized" set (the sliding-window `dropped` set's analog). Grows only within a
	 * session; cleared on attach. The summary group covers `compactedIds ∩ aged region`.
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

		// AGED REGION: every block older than the protected working tail that is not
		// human-held and not already inside a (non-conductor) group. ALL kinds are included
		// — user, text, thinking, tool_call, tool_result — because the single summary group
		// swallows the whole region and the host's whole-message snap + pair-balance keeps
		// the result wire-valid. `tool_call`/`tool_result` pairs are never orphaned: the host
		// folds a call together with its result or neither.
		const aged = this.agedRegion(view);

		// Degenerate config / empty session: nothing to manage. Hold any existing summary.
		if (view.budget <= 0 || view.blocks.length === 0) {
			return this.summary !== null ? this.emitSummaryGroup(view) : [];
		}

		// If a completion is in-flight, hold the current state — never launch a second.
		if (this.inflight !== null) return this.emitSummaryGroup(view);

		// The blocks already represented by the summary that are still in the aged region.
		// These are what the summary group covers, and their tokens are the saving that
		// shrinks the VISIBLE window below the raw `liveTokens`.
		const survivors = aged.filter((b) => this.compactedIds.has(b.id));

		// VISIBLE window = raw baseline minus the token saving the summary group provides.
		// `view.liveTokens` is the RAW size (host clears conductor folds each pass), so
		// without subtracting the saving the 90% trigger would fire on every pass once first
		// crossed. This is the sliding-window hysteresis computation, with the summary's own
		// token cost counted back in (the group replaces the survivors with the summary text).
		const savedTokens = this.summary !== null
			? Math.max(0, sumTokens(survivors) - this.summaryTokenCost())
			: 0;
		const visible = view.liveTokens - savedTokens;
		const overThreshold = visible >= view.budget * TRIGGER;

		// What is genuinely new since the last successful compaction.
		const newlyAged = aged.filter((b) => !this.compactedIds.has(b.id));

		// Nothing aged and no prior summary → nothing to do, clear to raw.
		if (aged.length === 0 && this.summary === null) {
			this.host.setStatus(null);
			return [];
		}

		// Trigger only when the VISIBLE window is at/over the high-water mark AND there are
		// newly-aged blocks to fold in. Below the mark, or with nothing new, HOLD: re-emit the
		// existing summary group (or clear to raw if no summary yet).
		const needSummary = overThreshold && newlyAged.length > 0;
		if (!needSummary) {
			this.host.setStatus(null);
			return this.summary !== null ? this.emitSummaryGroup(view) : [];
		}

		// DEGRADE path: if the host cannot run completions (live model not connected),
		// report unavailability and preserve the current state. No deterministic grouping
		// fallback: this conductor is specifically the LLM-summary baseline, so if the host
		// cannot complete we wait visibly rather than silently switching strategies.
		if (!this.host.can("complete")) {
			this.host.setStatus("Naive compaction unavailable — waiting for live model link", {
				aged: aged.length,
				fullness: Math.round((visible / view.budget) * 100),
			});
			return this.summary !== null ? this.emitSummaryGroup(view) : [];
		}
		this.host.setStatus(null);

		// Gate the launch on a stable signature of the NEWLY AGED set being attempted
		// (not the full aged set). This prevents re-launching after a rejection on the same
		// newly-aged set, and re-launching when the aged set merely SHRINKS (a shrink does
		// not change newlyAged ids). A genuinely new aged block changes newlyAged → new key
		// → retry is allowed.
		const attemptKey = newlyAged.map((b) => b.id).sort().join("\0");
		if (attemptKey === this.lastAttemptKey) {
			// Same newly-aged set as the last (failed) attempt — hold current state.
			return this.summary !== null ? this.emitSummaryGroup(view) : [];
		}

		// LAUNCH a background completion. Snapshot the aged ids NOW so the async resolve
		// handler commits the summary against exactly the blocks it summarized, regardless of
		// what the view looks like when it resolves.
		this.launchCompletion(aged, newlyAged, attemptKey);

		// Hold while the completion is in-flight: re-emit the existing summary group if one
		// is already applied, or null on the very first trip (no prior summary yet — the ONE
		// correct use of null: genuinely still thinking, nothing applied).
		return this.emitSummaryGroup(view);
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	/**
	 * The aged region: every block older than the protected working tail that is not
	 * human-held and not already inside a group. All kinds included (the single summary
	 * group swallows the whole region; the host pair-balances tool calls/results).
	 */
	private agedRegion(view: ConductorView): ViewBlock[] {
		const aged: ViewBlock[] = [];
		for (let i = 0; i < view.protectedFromIndex && i < view.blocks.length; i++) {
			const b = view.blocks[i];
			if (!b.held && !b.grouped) aged.push(b);
		}
		return aged;
	}

	/**
	 * Emit the summary as `group` command(s) (digest = summary) covering the compacted
	 * survivors in the aged region. Mirrors sliding-window's `emitRuns`, but with the LLM
	 * summary as the digest instead of `null` (drop).
	 *
	 * Re-derived from the LIVE view on every call (FIX for the data-loss class of bug):
	 *   - A survivor is a block in `compactedIds` that is still in the aged prefix and not
	 *     held / not grouped. (Protected blocks are outside the prefix by definition.)
	 *   - If no survivors → `[]` (clear to raw; lossless — the host resets all blocks to
	 *     full live content this pass).
	 *   - Otherwise emit one `group(first, last, digest)` per MAXIMAL CONTIGUOUS run of
	 *     survivors, walking the FULL aged prefix (including held/grouped blocks) so a
	 *     block the human holds SPLITS the run rather than being spanned. Under
	 *     `human-steering` the aged region is contiguous, so there is exactly ONE run →
	 *     one summary tile (the design intent). A pre-existing held/grouped block splitting
	 *     the region yields one group per side, each carrying the summary digest — every
	 *     survivor stays summarized, none is dropped. (Spanning the held block instead would
	 *     make the host clamp the whole group `human-override`, dropping the summary for
	 *     ALL survivors that pass.)
	 *
	 * The host snaps each run outward to whole messages and refuses one whose snapped
	 * range reaches into the protected tail (`invalid-group` clamp) — the same boundary
	 * straggler caveat sliding-window documents. Refused runs' blocks simply stay live
	 * that pass (no data loss) and rejoin when the boundary clears.
	 *
	 * Returns:
	 *   - null  → no summary yet (used ONLY while a first-trip completion is in-flight).
	 *   - []    → no surviving compacted blocks to cover (clear to raw; lossless).
	 *   - [...] → one `group` command per contiguous survivor run, digest = summary.
	 */
	private emitSummaryGroup(view: ConductorView): Command[] | null {
		if (this.summary === null) return null;

		const cmds: Command[] = [];
		let runStart = -1;
		let runEnd = -1;
		let survivorCount = 0;
		const flush = (): void => {
			if (runStart === -1) return;
			cmds.push({
				kind: "group",
				ids: [view.blocks[runStart].id, view.blocks[runEnd].id],
				digest: this.summary!,
			});
			runStart = -1;
			runEnd = -1;
		};
		const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
		for (let i = 0; i < pfi; i++) {
			const b = view.blocks[i];
			if (this.compactedIds.has(b.id) && !b.held && !b.grouped) {
				survivorCount++;
				if (runStart === -1) runStart = i;
				runEnd = i;
			} else {
				flush();
			}
		}
		flush();
		if (survivorCount === 0) return [];
		return cmds;
	}

	/**
	 * The token cost of the current summary, via the host's tokenizer when available,
	 * else a length/4 estimate. Used only to compute the VISIBLE window for the trigger.
	 */
	private summaryTokenCost(): number {
		if (this.summary === null) return 0;
		if (this.host && this.host.can("countTokens")) return this.host.countTokens(this.summary);
		return Math.ceil(this.summary.length / 4);
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
		// so it commits the summary against exactly the blocks it summarized, regardless of
		// what the view looks like when it resolves.
		const launchedAgedIds = new Set(agedBlocks.map((b) => b.id));
		const count = agedBlocks.length;

		// Build the user-role prompt.
		const prompt = this.buildPrompt(newlyAged);

		// Record the attempt key (keyed on newlyAged ids) so that a rejected completion
		// does NOT immediately re-launch for the same newly-aged set on the next conduct() tick.
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
				// Stale-completion guard: if this conductor was detached (or swapped and
				// re-attached, launching a new controller) while this promise was outstanding,
				// `this.inflight` no longer points at OUR controller. Bail without touching
				// `summary`/`compactedIds`/`inflight` — a stale result must never overwrite the
				// new session's state, and clearing `inflight` here would clobber a fresh
				// in-flight completion. (The host is contractually expected to reject on abort,
				// but a completer that resolves regardless must still be safe.)
				if (this.inflight !== controller) return;
				const text = result.text.trim();
				if (!text) {
					// Empty output would collapse the aged context behind a header-only summary.
					// Treat it as a failed attempt: preserve the prior summary/state and wait for
					// genuinely new aged content before retrying this same key.
					this.inflight = null;
					this.host?.setStatus("Naive compaction failed — model returned an empty summary", {
						aged: count,
					});
					return;
				}
				// Success: commit the new summary. The group covers `compactedIds ∩ aged` and is
				// re-derived from the live view every pass by emitSummaryGroup, so it stays valid
				// even if blocks shift, vanish, or re-home across the protected boundary.
				this.inflight = null;
				this.summary =
					`[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n` +
					text;
				this.compactedIds = launchedAgedIds;
				// Ask the host to re-run conduct() now so the summary group takes effect
				// immediately rather than waiting for the next natural context change.
				this.host?.requestRerun();
			},
			(_err) => {
				// Stale-completion guard (see the resolve handler): a reject from a controller
				// that is no longer current must not clear a fresh in-flight completion.
				if (this.inflight !== controller) return;
				// Rejected (abort, network error, unknown model, etc.): clear inflight but
				// leave prior summary/state intact. We do NOT immediately relaunch — the
				// lastAttemptKey guard ensures we only retry when genuinely new aged content
				// arrives (changing the attempt key). This prevents a tight model-hammering
				// loop on a persistent failure.
				this.inflight = null;
			},
		);
	}

	/**
	 * Build the user-role prompt for the compaction completion. The format spec itself lives
	 * in `COMPACTION_SYSTEM` (identical for both passes); this method only varies the INPUT
	 * wrapper and the one-line mode preamble.
	 *
	 * Inputs are wrapped in XML tags (`<conversation>`, `<previous-summary>`) — pi's
	 * convention — so the boundary between "stuff to summarize" and the instructions is
	 * unambiguous, which matters most on the recursive pass where two inputs coexist.
	 *
	 * FIRST compaction (summary == null):
	 *   `<conversation>` … `</conversation>` + "Create a structured summary …".
	 *   Every newly-aged block is included verbatim (all kinds), labeled by role/kind.
	 *
	 * RECURSIVE compaction (summary != null):
	 *   `<previous-summary>` … `</previous-summary>` + `<conversation>` … `</conversation>`
	 *   + explicit PRESERVE/REMOVE/MERGE instructions. The originals already compressed
	 *   into the prior summary are DELIBERATELY NOT re-read — this recursive amnesia is the
	 *   entire point of the baseline: it faithfully reproduces the compounding quality loss
	 *   mainstream tools impose (each compaction can only see the previous summary, not the
	 *   originals).
	 *
	 *   The merge instructions are deliberate, NOT a mitigation that defeats the foil:
	 *   structural amnesia (originals gone, unfixable by any prompt) is what the foil
	 *   demonstrates, and it is unaffected. Without merge instructions the model can
	 *   silently DROP the prior summary and summarize only the new blocks — a prompt
	 *   defect, not the structural loss the foil is built to show. Real tools (pi's
	 *   `UPDATE_SUMMARIZATION_PROMPT`, OpenCode's update branch) all carry explicit
	 *   preserve/merge wording, so the foil does too: a baseline that degrades DESPITE
	 *   best-effort preservation is a more convincing case for Accordion than one that
	 *   degrades from weak prompting. User messages fare better still: the instructions
	 *   require carrying every verbatim user message forward, so they survive intact across
	 *   compactions; only assistant reasoning degrades.
	 */
	private buildPrompt(newlyAged: ViewBlock[]): string {
		const conversation = newlyAged
			.map((b) => {
				const label = blockLabel(b);
				const text = (b.text ?? "").trim();
				return text ? `[${label}]\n${text}` : `[${label}]`;
			})
			.join("\n\n");

		if (this.summary !== null) {
			// Recursive path: feed the PRIOR SUMMARY + only the NEWLY AGED blocks. The
			// originals already compressed are DELIBERATELY NOT re-read (recursive amnesia).
			// The merge instructions make the model carry the prior summary forward (so it
			// does not silently drop it) and keep every verbatim user message intact; the
			// structural amnesia is unaffected, so the compounding loss the foil demonstrates
			// is preserved.
			return [
				"<previous-summary>",
				this.summary,
				"</previous-summary>",
				"",
				"<conversation>",
				conversation,
				"</conversation>",
				"",
				"Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move completed work into \"Progress\" and revise \"Next Steps\" accordingly. Preserve exact file paths, function names, and error messages when known. Carry forward every verbatim user message from the previous summary and append the new user messages from the conversation — all still reproduced word-for-word in \"## User messages\".",
			].join("\n");
		}

		// First compaction.
		return [
			"<conversation>",
			conversation,
			"</conversation>",
			"",
			"Create a structured summary from the conversation history above.",
		].join("\n");
	}
}

// ── utilities ─────────────────────────────────────────────────────────────────

/** Sum the full token cost of a set of blocks. */
function sumTokens(blocks: ViewBlock[]): number {
	let n = 0;
	for (const b of blocks) n += b.tokens;
	return n;
}

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

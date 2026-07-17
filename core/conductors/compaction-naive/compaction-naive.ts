/*
 * core/conductors/compaction-naive/compaction-naive.ts — the "Naive compaction" conductor.
 *
 * PORTED from the deleted `conductors/compaction-naive/compaction-naive.ts` (ADR 0014, git rev
 * dc037bc) onto the NEW conductor-v2 contract, via the `ViewConductor` adapter
 * (`core/conductor/view.ts`) that bridges the OLD `conduct(view) → Command[] | null` vocabulary.
 * The algorithm — trigger math, aged-region selection, prompt construction, recursive-amnesia
 * shape, in-flight/retry bookkeeping — is unchanged. Only the host seam differs; see the PORT
 * FIDELITY notes below for every place that forced a real (not cosmetic) adaptation.
 *
 * PURPOSE (unchanged): a deliberate BASELINE / FOIL that reproduces what mainstream AI coding
 * tools do today. When the context approaches capacity, it calls an LLM to summarize the aged
 * history into a single prose summary and presents the agent that ONE summary IN PLACE of the
 * whole aged region — faithfully reproducing what Cursor's composer, Claude Code's `/compact`,
 * and similar tools do.
 *
 * It is DELIBERATELY LOSSY AND RECURSIVE:
 *   - Lossy: the aged blocks are collapsed into ONE group whose digest is the generated summary.
 *     There is no `{#code FOLDED}` tag on the summary, so the agent cannot call `unfold` to
 *     recover the originals. The human can always DETACH this conductor to recover full history;
 *     the agent cannot. That asymmetry is the whole point.
 *   - Recursive: each subsequent compaction summarizes the PRIOR SUMMARY + only the newly aged
 *     blocks. It never re-reads the originals already compressed — the self-imposed amnesia
 *     compounds quality loss over a session, the exact failure mode Accordion's reversible
 *     folding is designed to avoid.
 *
 * SHAPE — a `group(digest: <LLM summary>)` command (REPLACE the aged run with one summary
 * message), close cousin of the sliding-window conductor's `group(digest: null)` (DROP). The
 * adapter's `applyDesired` maps a non-empty string `digest` to the group op's verbatim-summary
 * path — never tagged. The host snaps the run outward to whole messages and pair-balances
 * `tool_call`/`tool_result`, so no tool result is ever orphaned.
 *
 * PORT FIDELITY — real adaptations, not cosmetic renames:
 *
 *   1. NO `host.can()`. The old contract's `ConductorHost.can("complete")` let this conductor
 *      synchronously check availability BEFORE launching a completion, and BEFORE even
 *      considering `countTokens` a possibility. The new `ConductorHost` (`core/conductor/
 *      contract.ts`) has no such capability probe: `countTokens` is unconditionally available,
 *      and a REJECTED `complete()` promise IS the "unavailable" signal. So the old
 *      `if (!host.can("complete")) { setStatus(...); return ...; }` pre-flight branch is GONE —
 *      this conductor always attempts the call (subject to the same `lastAttemptKey` gate it
 *      always had) and lets the reject handler report unavailability via `setStatus`.
 *
 *   2. `this.rerun()` replaces `host.requestRerun()`. The old contract had the host re-invoke
 *      `conduct()` on request; the new `ViewConductor` adapter is exactly that local successor —
 *      `rerun()` is a protected method a subclass calls directly once its async work resolves.
 *
 *   3. TRIGGER MATH — the raw baseline can no longer come from `view.liveTokens`. The OLD
 *      contract's `ConductorView.liveTokens` was, per ADR 0014 §2, "the RAW, fully-unfolded size
 *      (the host clears conductor folds before every pass)" — it only ever grew, which is what
 *      let the conductor track its OWN token saving locally and subtract it to get a `visible`
 *      window that drops right after a compaction and climbs back up as new blocks age in.
 *
 *      In the NEW core, a `group` op this conductor proposes is a PERSISTENT Truth-level overlay
 *      (`Truth.groupList`), not something the host clears and re-derives every pass — so
 *      `Truth.stats().liveTokens` (which `ConductorView.liveTokens` is materialized from) already
 *      reflects THIS conductor's own prior group folding. Subtracting `savedTokens` from it a
 *      second time would double-count the saving and starve the trigger.
 *
 *      The fix: `ViewBlock.tokens` is documented (`contract.ts`) as the block's "Full token
 *      cost" — unaffected by whatever fold/group state Truth currently carries. Summing it over
 *      EVERY block (`sumTokens(view.blocks)`) reconstructs exactly the always-growing raw
 *      baseline the original algorithm assumed, without relying on a stats field whose meaning
 *      changed underneath the port. Everything downstream — `savedTokens = Σ survivor tokens −
 *      summary cost`, `visible = rawTotal − savedTokens`, `visible >= 0.9 * budget` — is the
 *      untouched original formula, just fed a locally-reconstructed `rawTotal` instead of
 *      `view.liveTokens`.
 *
 *   4. Sticky reject status. The old reject handler only cleared `inflight` (no `setStatus` —
 *      unavailability was reported by the separate `can()` pre-check instead). Without that
 *      pre-check, this port reports failure directly from the reject handler so a human still
 *      sees WHY nothing is progressing; the status is sticky (left in place) until a genuinely
 *      new aged set changes `lastAttemptKey` and a fresh attempt clears it via `setStatus(null)`
 *      right before launching.
 *
 *   5. `ViewBlock.grouped` no longer means "skip this block" in `agedRegion` / `emitSummaryGroup`.
 *      The OLD contract's per-pass view was pre-cleared of THIS conductor's own prior fold/group
 *      (see §3's ADR 0014 §2 quote), so a `grouped` block there could only mean "some OTHER
 *      (human) group already owns this" — worth skipping. The new adapter does NOT clear a
 *      conductor's own standing group before materializing the view — it is a PERSISTENT Truth
 *      overlay the adapter reconciles by diffing (`ViewConductor.applyDesired`) — so by the
 *      SECOND pass `grouped` is ALSO true for blocks this conductor itself grouped on the prior
 *      pass. Naively keeping the old `!b.grouped` check made `agedRegion` (and
 *      `emitSummaryGroup`'s survivor walk) silently drop its own already-compacted survivors every
 *      subsequent pass, so the adapter diffed the standing group away (`ungroup`) on every pass
 *      after the first — observed directly as a spurious extra `complete()` launch per pass in
 *      this port's own tests before the fix. Both helpers now check `foreignGroupedIds()` — the
 *      set of ids in a folded group with `by !== "auto"` (every conductor-proposed op runs under
 *      actor `"auto"`, so `by !== "auto"` reliably means "a human made this group") — instead of
 *      the blanket `ViewBlock.grouped`.
 *
 *   6. OUTPUT-TOKEN RESERVATION against the context window (external review round, P1-7). The
 *      original port requested a flat `maxOutputTokens: MAX_SUMMARY_TOKENS` with no regard for how
 *      much of the window the aged-region input already consumes — at the 0.9 trigger, input ≈
 *      0.9×budget, so `input + 8000` can exceed the model's real context window whenever the window
 *      is not comfortably larger than the budget, and the provider rejects the call with a 400 (a
 *      STICKY failure, since `lastAttemptKey` then blocks any retry until new content ages in). The
 *      sibling `handoff` conductor (`core/conductors/handoff/handoff.ts`) already solved this exact
 *      problem for its own completion call; this port copies that reservation faithfully (same
 *      floor/margin/cap constants, same three-branch shape, same "decline outright rather than send
 *      a doomed request" behavior) rather than reinventing it. See `launchCompletion` below.
 *
 * Everything else — `emitSummaryGroup`'s per-run walk shape (held/foreign-grouped blocks split
 * the region into multiple groups, each carrying the same digest), `COMPACTION_SYSTEM`, both
 * `buildPrompt` branches, the `lastAttemptKey` retry gate, and the stale-completion guard
 * (controller identity) — is ported unchanged.
 *
 * No Svelte, no `$state`, no engine imports. Types only from `../../conductor/contract` and
 * `../../conductor/view`.
 */
import { ViewConductor, type Command, type ConductorView } from "../../conductor/view";
import type { ConductorHost, LockName, ViewBlock } from "../../conductor/contract";

/** Fraction of budget at which compaction triggers (high-water mark). Unchanged from ADR 0014. */
const TRIGGER = 0.9;

/**
 * Soft cap on summary output tokens.
 *
 * Sized for the job: this conductor compacts roughly 20k-200k tokens of aged history at a time,
 * so the briefing needs room to retain the important signals — 1.5k was far too tight. 8k still
 * represents a large reduction (~2.5x at 20k of input, ~25x at 200k) while leaving a useful
 * structured summary.
 *
 * The host clamps the requested max to the model's own max-output ceiling before sending the
 * call, and the model enforces it as a hard generation cap — so requesting more than a given
 * model allows is safe (it is clamped, not rejected). If the summary would exceed the (clamped)
 * ceiling, the output is TRUNCATED (finish-reason "length") and used as-is — acceptable for a
 * lossy baseline.
 *
 * NOTE: this is only the UPPER bound. The host clamp bounds the request to the model's own
 * max-OUTPUT ceiling, but it does NOT bound `input + output` against the context window — so a
 * blind `MAX_SUMMARY_TOKENS` request overflows the window whenever the aged-region input is large
 * relative to the window (at the 0.9 trigger, input ≈ 0.9×budget, so `input + 8000` exceeds any
 * window not comfortably larger than budget and the provider 400s). `launchCompletion` therefore
 * RESERVES output room against the reported window; see there. Ported from the identical note on
 * the sibling `handoff` conductor's `MAX_HANDOFF_TOKENS` (PORT FIDELITY §6).
 */
const MAX_SUMMARY_TOKENS = 8000;

/**
 * Floor for a useful summary. If reserving output room against the window (see `launchCompletion`)
 * leaves fewer than this many tokens, the aged-region input itself nearly fills the window — there
 * is no room to write a summary — so the conductor declines the request with a visible status
 * rather than sending a doomed call. Mirrors `handoff`'s `MIN_HANDOFF_TOKENS` (PORT FIDELITY §6).
 */
const MIN_SUMMARY_TOKENS = 1000;

/**
 * Headroom subtracted when reserving output room against the window: covers per-message role/
 * delimiter overhead and chars/4 tokenizer drift between our estimate and the provider's count, so
 * a reservation computed as "just fits" does not tip the real request over the window. Mirrors
 * `handoff`'s `OUTPUT_SAFETY_MARGIN` (PORT FIDELITY §6).
 */
const OUTPUT_SAFETY_MARGIN = 512;

/**
 * System prompt for the compaction LLM call. Ported VERBATIM from the deleted conductor (ADR
 * 0014 §8) — industry-standard structured-briefing template with one sacred rule lifted from
 * Claude Code's `/compact`: user messages are reproduced VERBATIM so the human's intent and
 * instructions survive every compaction intact. Only assistant text/thinking/tool calls/tool
 * results are summarized.
 */
export const COMPACTION_SYSTEM = `\
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

export class NaiveCompactionConductor extends ViewConductor {
	readonly id = "compaction-naive";
	readonly label = "Naive compaction";

	/**
	 * Involvement locks (ADR 0011). This conductor takes EXCLUSIVE control of the two STEERING
	 * controls — the human's hand fold/unfold/pin/group/reset and the agent's `unfold` tool — so
	 * the user, the agent, and the conductor cannot fight over the same blocks while a compaction
	 * pass is rewriting them. `human-steering` is load-bearing for the single-group shape: under
	 * that lock the human cannot pin or group a block inside the aged region, so the region stays
	 * CONTIGUOUS and the one `group` command covering it is always valid (the host refuses a run
	 * that spans a human-held block). Dropping the lock would let a held block split the region,
	 * fragmenting the single summary tile.
	 *
	 * Deliberately does NOT lock `tail-size` (see ADR 0014 §4 for the full reasoning) — this
	 * conductor relies on the host's protected tail rather than owning its own.
	 *
	 * Note on `agent-unfold`: because this conductor emits a `group` (no `{#code FOLDED}` tags),
	 * the agent never has a fold code for a compacted block, so it could not `unfold` (or even
	 * `recall`) one regardless. The lock is the honest declaration of intent and future-proofs
	 * against the agent unfolding any OTHER folded block while this conductor is exclusive.
	 *
	 * NOTHING applies this list today — the new contract's host (Phase C) owns turning a
	 * conductor's declared `locks` into an actual `Truth.setLocks(...)` call on attach/detach.
	 * This conductor only DECLARES the intent; enforcement is out of scope for this port.
	 */
	readonly locks: readonly LockName[] = ["human-steering", "agent-unfold"];

	// ── instance state (unchanged from the pre-excision conductor) ──────────────

	/** The current compaction summary text (with its count preamble). Null until the first summary completes. */
	private summary: string | null = null;

	/**
	 * The block ids currently represented by the summary — the monotonic "already summarized"
	 * set (the sliding-window `dropped` set's analog). Grows only within a session; cleared on
	 * attach. The summary group covers `compactedIds ∩ aged region`. Empty until the first
	 * summary completes.
	 */
	private compactedIds: Set<string> = new Set();

	/** AbortController for the current in-flight completion, or null when idle. */
	private inflight: AbortController | null = null;

	/**
	 * A stable key representing the NEWLY AGED block set most recently ATTEMPTED (a completion
	 * was launched for it). Keyed on `newlyAged` ids (NOT the full aged set) so a pure SHRINK of
	 * the aged set (e.g. a human pins an old block) does not change the key and does not
	 * relaunch; a genuinely new aged block DOES change it and correctly allows a retry.
	 */
	private lastAttemptKey = "";

	// ── lifecycle ────────────────────────────────────────────────────────────────

	/**
	 * A conductor lifetime starts fresh on attach — do not let a summary or retry key from a
	 * prior session leak into the next one. `super.attach(host)` wires the adapter's own
	 * bookkeeping (host reference, event subscription, tracked applied folds/groups).
	 */
	attach(host: ConductorHost): void {
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.summary = null;
		this.compactedIds = new Set();
		this.lastAttemptKey = "";
		super.attach(host);
	}

	/** Cancel any in-flight completion so a stale result cannot mutate state after detach. */
	detach(): void {
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.host.setStatus(null);
		super.detach();
	}

	// ── main conduct loop ─────────────────────────────────────────────────────────

	conduct(view: ConductorView): Command[] | null {
		// AGED REGION: every block older than the protected working tail that is not human-held
		// and not already inside a FOREIGN (non-this-conductor) group. ALL kinds are included —
		// user, text, thinking, tool_call, tool_result — because the single summary group
		// swallows the whole region and the host's whole-message snap + pair-balance keeps the
		// result wire-valid.
		const aged = this.agedRegion(view);

		// Degenerate config / empty session: nothing to manage. Hold any existing summary.
		if (view.budget <= 0 || view.blocks.length === 0) {
			return this.summary !== null ? this.emitSummaryGroup(view) : [];
		}

		// If a completion is in-flight, hold the current state — never launch a second.
		if (this.inflight !== null) return this.emitSummaryGroup(view);

		// The blocks already represented by the summary that are still in the aged region. These
		// are what the summary group covers, and their tokens are the saving that shrinks the
		// VISIBLE window below the raw baseline.
		const survivors = aged.filter((b) => this.compactedIds.has(b.id));
		const savedTokens = this.summary !== null ? Math.max(0, sumTokens(survivors) - this.summaryTokenCost()) : 0;

		// RAW baseline: Σ full token cost over EVERY block (aged or protected). See the "PORT
		// FIDELITY" §3 note at the top of this file for why this is reconstructed locally from
		// `ViewBlock.tokens` rather than read off `view.liveTokens`.
		const rawTotal = sumTokens(view.blocks);
		const visible = rawTotal - savedTokens;
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

		// Gate the launch on a stable signature of the NEWLY AGED set being attempted (not the
		// full aged set). Prevents relaunching after a rejection on the SAME newly-aged set, and
		// relaunching when the aged set merely SHRINKS (a shrink does not change newlyAged ids).
		// A genuinely new aged block changes newlyAged → new key → retry is allowed. The status a
		// rejection set (see `launchCompletion`) is left STICKY across this early return — it is
		// only cleared right before a fresh attempt actually launches, below.
		const attemptKey = newlyAged
			.map((b) => b.id)
			.sort()
			.join("\0");
		if (attemptKey === this.lastAttemptKey) {
			return this.summary !== null ? this.emitSummaryGroup(view) : [];
		}

		// About to attempt — clear any previous failure status. (launchCompletion may immediately
		// overwrite this with a decline status if the context window leaves no room to reserve
		// output — see there.)
		this.host.setStatus(null);

		// LAUNCH a background completion (which may DECLINE if the window is too tight — see
		// launchCompletion). Snapshot the aged ids NOW so the async resolve handler commits the
		// summary against exactly the blocks it summarized, regardless of what the view looks like
		// when it resolves. `view.contextWindow` is threaded in so the request reserves output room
		// against the real window.
		this.launchCompletion(aged, newlyAged, attemptKey, view.contextWindow);

		// Hold while the completion is in-flight: re-emit the existing summary group if one is
		// already applied, or null on the very first trip (no prior summary yet — the ONE correct
		// use of null: genuinely still thinking, nothing applied).
		return this.emitSummaryGroup(view);
	}

	// ── helpers ───────────────────────────────────────────────────────────────────

	/**
	 * Ids currently inside a FOLDED group this conductor did NOT create. Every conductor-proposed
	 * op runs under actor `"auto"` (`ConductorHost.propose` → `Truth.apply(ops, "auto", …)`, see
	 * `ViewConductor.applyDesired`), so `g.by !== "auto"` reliably means "a human made this group"
	 * — the only kind of FOREIGN group this exclusive conductor can encounter. See PORT FIDELITY
	 * §5 for why this is used instead of the blanket `ViewBlock.grouped`.
	 */
	private foreignGroupedIds(): Set<string> {
		const ids = new Set<string>();
		for (const g of this.host.groups()) {
			if (g.by === "auto") continue; // this conductor's own standing group — never foreign
			for (const id of g.memberIds) ids.add(id);
		}
		return ids;
	}

	/**
	 * The aged region: every block older than the protected working tail that is not human-held
	 * and not already inside a FOREIGN group. All kinds included (the single summary group
	 * swallows the whole region; the host pair-balances tool calls/results).
	 */
	private agedRegion(view: ConductorView): ViewBlock[] {
		const foreign = this.foreignGroupedIds();
		const aged: ViewBlock[] = [];
		for (let i = 0; i < view.protectedFromIndex && i < view.blocks.length; i++) {
			const b = view.blocks[i];
			if (!b.held && !foreign.has(b.id)) aged.push(b);
		}
		return aged;
	}

	/**
	 * Emit the summary as `group` command(s) (digest = summary) covering the compacted survivors
	 * in the aged region. Re-derived from the LIVE view on every call:
	 *   - A survivor is a block in `compactedIds` that is still in the aged prefix, not held, and
	 *     not inside a FOREIGN group. (Protected blocks are outside the prefix by definition. Our
	 *     OWN standing group from a prior pass does NOT disqualify a block — see PORT FIDELITY §5.)
	 *   - If no survivors → `[]` (clear to raw; lossless).
	 *   - Otherwise emit one `group(first, last, digest)` per MAXIMAL CONTIGUOUS run of survivors,
	 *     walking the FULL aged prefix (including held/foreign-grouped blocks) so a block the human
	 *     holds SPLITS the run rather than being spanned. Under `human-steering` the aged region is
	 *     contiguous, so there is exactly ONE run in the common case; a pre-existing held/foreign-
	 *     grouped block splitting the region yields one group per side, each carrying the digest.
	 *
	 * Returns:
	 *   - null  → no summary yet (used ONLY while a first-trip completion is in-flight).
	 *   - []    → no surviving compacted blocks to cover (clear to raw; lossless).
	 *   - [...] → one `group` command per contiguous survivor run, digest = summary.
	 */
	private emitSummaryGroup(view: ConductorView): Command[] | null {
		if (this.summary === null) return null;

		const foreign = this.foreignGroupedIds();
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
			if (this.compactedIds.has(b.id) && !b.held && !foreign.has(b.id)) {
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
	 * The token cost of the current summary, via the host's tokenizer. Used only to compute the
	 * VISIBLE window for the trigger. (The old `host.can("countTokens")` guard is gone — the new
	 * contract's `countTokens` is unconditionally available; see PORT FIDELITY §1.)
	 */
	private summaryTokenCost(): number {
		if (this.summary === null) return 0;
		return this.host.countTokens(this.summary);
	}

	/**
	 * Fire-and-forget: build the compaction prompt and launch a `host.complete()` call. `conduct()`
	 * returns immediately after calling this; the result comes back via the resolve handler, which
	 * calls `this.rerun()` (the adapter's local successor to the old `host.requestRerun()`) to
	 * schedule a fresh `conduct()` pass so the summary group takes effect immediately.
	 *
	 * @param agedBlocks    - all aged blocks at launch time (SNAPSHOT — don't use the view later).
	 * @param newlyAged     - subset not already in compactedIds (used to build the recursive prompt).
	 * @param attemptKey    - the sorted-join key of the NEWLY AGED set being attempted; stored to
	 *                        prevent relaunching the same newly-aged set after a rejection.
	 * @param contextWindow - the model's total context window (or null if unknown), used to reserve
	 *                        output room so `input + output` cannot overflow the window (PORT
	 *                        FIDELITY §6, mirrors `handoff.ts`'s `launchCompletion`).
	 */
	private launchCompletion(agedBlocks: ViewBlock[], newlyAged: ViewBlock[], attemptKey: string, contextWindow: number | null): void {
		if (this.inflight !== null) return; // defensive: should never reach here while inflight

		// Snapshot the ids and count at LAUNCH TIME. The resolve handler closes over these so it
		// commits the summary against exactly the blocks it summarized, regardless of what the
		// view looks like when it resolves.
		const launchedAgedIds = new Set(agedBlocks.map((b) => b.id));
		const count = agedBlocks.length;

		const prompt = this.buildPrompt(newlyAged);

		// Record the attempt key (keyed on newlyAged ids) so a rejected OR declined completion does
		// NOT immediately relaunch for the same newly-aged set on the next conduct() tick.
		this.lastAttemptKey = attemptKey;

		// RESERVE output room against the context window (PORT FIDELITY §6). The host clamp bounds
		// max-OUTPUT only, not `input + output`, so a blind MAX_SUMMARY_TOKENS request overflows the
		// window when the aged-region input is large relative to it (the 0.9 trigger puts input near
		// the budget). Derive the cap from the actual input size. When the window is unknown (null),
		// we cannot reserve — fall back to MAX_SUMMARY_TOKENS and rely on the host's max-output clamp
		// (today's flat behavior, unchanged).
		let maxOutputTokens = MAX_SUMMARY_TOKENS;
		if (contextWindow != null && contextWindow > 0) {
			const inputTokens = this.host.countTokens(COMPACTION_SYSTEM) + this.host.countTokens(prompt);
			const reserve = contextWindow - inputTokens - OUTPUT_SAFETY_MARGIN;
			if (reserve < MIN_SUMMARY_TOKENS) {
				// The aged-region input alone nearly fills the window — there is no room to write a
				// useful summary. Decline deliberately with a visible, sticky status instead of
				// sending a request the provider will reject. The attempt key is already recorded
				// above, so we do not re-attempt until genuinely new content ages in.
				this.host.setStatus(`Naive compaction needs a bigger window — input ≈ ${inputTokens} tokens leaves no room to write in a ${contextWindow}-token window`, {
					input: inputTokens,
					window: contextWindow,
				});
				return;
			}
			maxOutputTokens = Math.min(MAX_SUMMARY_TOKENS, reserve);
		}

		const controller = new AbortController();
		this.inflight = controller;

		this.host
			.complete({
				system: COMPACTION_SYSTEM,
				prompt,
				maxOutputTokens,
				signal: controller.signal,
			})
			.then(
				(result) => {
					// Stale-completion guard: if this conductor was detached (or re-attached,
					// launching a new controller) while this promise was outstanding, `this.inflight`
					// no longer points at OUR controller. Bail without touching
					// `summary`/`compactedIds`/`inflight` — a stale result must never overwrite the
					// new session's state, and clearing `inflight` here would clobber a fresh
					// in-flight completion.
					if (this.inflight !== controller) return;
					const text = result.text.trim();
					if (!text) {
						// Empty output would collapse the aged context behind a header-only summary.
						// Treat it as a failed attempt: preserve prior state and wait for genuinely
						// new aged content before retrying this same key.
						this.inflight = null;
						this.host.setStatus("Naive compaction failed — model returned an empty summary", {
							aged: count,
						});
						return;
					}
					// Success: commit the new summary. The group covers `compactedIds ∩ aged` and is
					// re-derived from the live view every pass by emitSummaryGroup, so it stays valid
					// even if blocks shift, vanish, or re-home across the protected boundary.
					this.inflight = null;
					this.summary = `[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n${text}`;
					this.compactedIds = launchedAgedIds;
					void this.rerun(); // async (v2 propose); its ops apply on invocation, results reconcile on a microtask
				},
				(_err) => {
					// Stale-completion guard (see above): a reject from a controller that is no
					// longer current must not clear a fresh in-flight completion.
					if (this.inflight !== controller) return;
					// Rejected (abort, unavailable model, network error, …): clear inflight but leave
					// prior summary/state intact. `lastAttemptKey` (already set above) ensures we only
					// retry when genuinely new aged content arrives. The status is STICKY — it stands
					// until a new attempt clears it (in `conduct()`, right before the next launch).
					this.inflight = null;
					this.host.setStatus("Naive compaction failed — waiting for new context to age in before retrying", {
						aged: newlyAged.length,
					});
				},
			);
	}

	/**
	 * Build the user-role prompt for the compaction completion. Ported VERBATIM (both branches).
	 * The format spec itself lives in `COMPACTION_SYSTEM` (identical for both passes); this method
	 * only varies the INPUT wrapper and the one-line mode preamble.
	 *
	 * FIRST compaction (summary == null): `<conversation>` … `</conversation>` + "Create a
	 * structured summary …". Every newly-aged block is included verbatim (all kinds), labeled by
	 * role/kind.
	 *
	 * RECURSIVE compaction (summary != null): `<previous-summary>` … `</previous-summary>` +
	 * `<conversation>` … `</conversation>` + explicit PRESERVE/REMOVE/MERGE instructions. The
	 * originals already compressed into the prior summary are DELIBERATELY NOT re-read — this is
	 * the recursive amnesia the baseline exists to demonstrate.
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
			return [
				"<previous-summary>",
				this.summary,
				"</previous-summary>",
				"",
				"<conversation>",
				conversation,
				"</conversation>",
				"",
				'Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move completed work into "Progress" and revise "Next Steps" accordingly. Preserve exact file paths, function names, and error messages when known. Carry forward every verbatim user message from the previous summary and append the new user messages from the conversation — all still reproduced word-for-word in "## User messages".',
			].join("\n");
		}

		return ["<conversation>", conversation, "</conversation>", "", "Create a structured summary from the conversation history above."].join("\n");
	}
}

// ── utilities ─────────────────────────────────────────────────────────────────

/** Sum the full token cost of a set of blocks. `ViewBlock.tokens` is always the FULL cost. */
export function sumTokens(blocks: readonly ViewBlock[]): number {
	let n = 0;
	for (const b of blocks) n += b.tokens;
	return n;
}

/** A short human-readable label for a block, used when building the compaction prompt. */
export function blockLabel(b: ViewBlock): string {
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
			// Exhaustive check — TypeScript errors here if a new kind is added without updating this.
			const _never: never = b.kind;
			return String(_never);
		}
	}
}

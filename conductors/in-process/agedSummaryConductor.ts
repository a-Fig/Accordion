/*
 * conductors/in-process/agedSummaryConductor.ts — shared base for the "aged region → one LLM-written
 * summary group" conductor shape, factored out of `compaction-naive/compaction-naive.ts` and
 * `handoff/handoff.ts` (PR #82 adversarial review: the two were ~90% duplicated — same
 * agedRegion/foreignGroupedIds/emit-group/launch-completion machinery and the same output-token
 * reservation block, and the duplication had already drifted: the two bugs fixed here (no
 * prompt-injection neutralizer in compaction-naive; user blocks silently swallowed into a
 * non-recoverable group despite a "verbatim" promise) existed in one sibling but not the other).
 *
 * `AgedSummaryConductor` owns everything that was byte-identical (or identical modulo a field
 * name) between the two: the aged-region derivation, foreign-grouped-id exclusion, the per-run
 * group-emission walk, the completion launch/inflight/attempt-key/sticky-failure-status lifecycle
 * (now including link-unavailability classification, see `isUnavailableError` below), the
 * output-token reservation math (MAX/MIN/MARGIN), and the `<conversation>`/`<prior-tag>` prompt
 * template with its prompt-injection neutralizer. A subclass supplies only what is genuinely
 * different: its system prompt, its two prompt instructions (first-pass / recursive), its
 * count-preamble format, and its four status messages (empty-output / window-too-tight / reject /
 * unavailable). `includeInGroup` (below) is an optional per-kind fold-eligibility hook a subclass
 * MAY override — neither shipped subclass does today (both `compaction-naive` and `handoff`
 * swallow every kind, including `user`, matching main's original behavior byte-for-byte), but the
 * hook stays available for a future conductor that genuinely needs to exclude a kind.
 *
 * No Svelte, no `$state`, no engine imports. Types come from `../conductor/contract` and
 * `../conductor/view`; the only VALUE imports outside those are the pure `core/` primitives that
 * decide what the wire will do with a proposed group (`collapsibleMessageKeys` / `messageKey` /
 * `roleFloorRecap` / `BLOCK_OVERHEAD`) — imported rather than re-derived precisely so this
 * conductor's judgment can never drift from the one `Truth`/`applyPlan` actually enforce.
 */
import { ViewConductor, type Command, type ConductorView } from "../../core/conductor/view";
import type { ConductorHost, LockName, ViewBlock } from "../../core/conductor/contract";
import { collapsibleMessageKeys, messageKey } from "../../core/groupShape";
import { isBolted } from "../../core/digest";
import { roleFloorRecap } from "../../core/wire";
import { estTokens, BLOCK_OVERHEAD } from "../../core/tokens";

/** Fraction of budget at which a run triggers (high-water mark). Shared by every subclass;
 *  exported so a subclass with its own activation logic (triptych's sticky pressure gate) keys off
 *  the same mark rather than growing a second constant to drift. */
export const TRIGGER = 0.9;

/**
 * Soft cap on completion output tokens. Sized for the job: both conductors summarize/hand off
 * roughly 20k-200k tokens of aged history at a time, so the output needs room to retain the
 * important signals. The host clamps the requested max to the model's own max-output ceiling
 * before sending the call, so requesting more than a given model allows is safe (clamped, not
 * rejected); if the result would exceed the (clamped) ceiling, the output is truncated
 * (finish-reason "length") and used as-is.
 *
 * NOTE: this is only the UPPER bound. It does NOT bound `input + output` against the context
 * window — see `launchCompletion`'s reservation math below for that.
 */
const MAX_OUTPUT_TOKENS = 8000;

/**
 * Floor for a useful summary/handoff. If reserving output room against the window leaves fewer
 * than this many tokens, the aged-region input alone nearly fills the window — there is no room
 * to write anything useful — so the conductor declines the request with a visible status rather
 * than sending a doomed call.
 */
const MIN_OUTPUT_TOKENS = 1000;

/**
 * Headroom subtracted when reserving output room against the window: covers per-message
 * role/delimiter overhead and chars/4 tokenizer drift between our estimate and the provider's
 * count, so a reservation computed as "just fits" does not tip the real request over the window.
 */
const OUTPUT_SAFETY_MARGIN = 512;

/**
 * A completed pass counts as PRODUCTIVE only if it shrank the visible wire by MORE than this many
 * tokens. Sized at roughly one framed wire message (`BLOCK_OVERHEAD` plus a short one-line body) —
 * the smallest unit of wire this machinery ever moves. Below it, the pass rearranged framing and
 * nothing else, and repeating it just spends another model call for the same nothing. See the
 * back-off in `conduct()`.
 */
const MIN_PASS_SAVING = 32;

/**
 * Break any closing `tags` sentinel hidden in interpolated, attacker-influenceable content so it
 * cannot end the prompt's data section early and inject instructions into the completion call.
 * Deterministic and whitespace-tolerant — no sanitizer library: it rewrites the leading `<` of any
 * such closing tag to the harmless `&lt;/…` so the model never sees a real closing tag. Opening
 * tags are left alone; only a CLOSING tag can break out of a wrapped section.
 *
 * `tags` is the set of tag names this call site wraps content in (always includes `"conversation"`
 * plus whatever the subclass's prior-round wrapper is named — `"previous-summary"` or
 * `"previous-handoff"`). Each conductor re-exports a zero-arg `neutralizeSentinels(s)` convenience
 * wrapper (pinned to its own tag set) so its own tests/call sites read exactly as they did before
 * this extraction — see the bottom of `compaction-naive.ts` / `handoff.ts`.
 */
export function neutralizeClosingTags(s: string, tags: readonly string[]): string {
	const alt = tags.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
	return s.replace(new RegExp(`<\\s*\\/\\s*(${alt})`, "gi"), "&lt;/$1");
}

/**
 * Sensible cap on a provider error message surfaced in the sticky status bar. The status bar is a
 * one-line UI affordance, not a log: an unbounded provider error — huge text, embedded
 * markup/HTML, a stack trace — would otherwise be embedded verbatim into the status.
 */
const ERROR_STATUS_MAX_LEN = 200;

/** Truncate `s` to at most `max` characters, appending an ellipsis when it was cut. */
export function truncateForStatus(s: string, max: number = ERROR_STATUS_MAX_LEN): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Classify a `complete()` rejection as "no live model link" — the same condition main's contract
 * reported ahead-of-time via `host.can("complete")` returning false. The v2 contract has no such
 * pre-check; a rejected `complete()` IS the only signal, so this classifies the rejection itself
 * rather than pre-flighting a capability query.
 *
 * Deliberately conservative, keyed on the EXACT message the two hosts this conductor ever runs
 * under actually produce for that condition:
 *   - `LiveConductorHost.complete()` (`core/conductor/liveHost.ts`) calls straight through to the
 *     extension's `runCompletion` (`extension/accordion.ts`), which throws `new Error("no model
 *     available")` when the session has no live model context yet (or after `session_shutdown`
 *     clears it) — the in-process path both conductors always use.
 *   - The one out-of-process path either conductor could in principle run under (a remote
 *     `ConductorHost`, `core/conductor/remote.ts`) rejects with `new Error(msg.error ?? "remote
 *     conductor: completion failed")`, where `msg.error` is that exact same `err.message` relayed
 *     verbatim over the wire from `handleCompleteRequest` — so the message text is unchanged
 *     end-to-end regardless of which host is in play.
 *
 * Matched case-insensitively as a substring (not an exact-string test) so a host that wraps the
 * message with a prefix still classifies correctly. No other pattern is included: this is the ONE
 * message either host actually produces for "no live model," and inventing broader patterns (e.g.
 * a bare `/unavailable/i`) would risk swallowing a genuine, transient provider error (a real 503,
 * a rate limit, a timeout) into the calm "waiting for link" status instead of the sticky failure
 * path — exactly the loose-matching mistake this function is deliberately built to avoid.
 */
export function isUnavailableError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	return /no model available/i.test(msg);
}

/** Sum the full token cost of a set of blocks. `ViewBlock.tokens` is always the FULL cost. */
export function sumTokens(blocks: readonly ViewBlock[]): number {
	let n = 0;
	for (const b of blocks) n += b.tokens;
	return n;
}

/** A short human-readable label for a block, used when building the completion prompt. Mirrors
 *  the role labeling convention in the Transcript view. */
export function blockLabel(b: ViewBlock): string {
	switch (b.kind) {
		case "system":
			// Unreachable via `agedRegion` (which filters bolted blocks out — nothing here may ever be
			// summarized away), but the exhaustive check below demands a case, and a label is the right
			// thing to have if a future prompt-builder legitimately wants to NAME the system prompt.
			return "system prompt";
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

/**
 * Shared base for a conductor that watches an aged region cross a 90%-of-budget high-water mark,
 * asks an LLM (via `host.complete()`) to write ONE piece of replacement text for it, and folds the
 * result in as an untagged `group` digest (no `{#code FOLDED}` — the agent has no `unfold` path
 * back to the originals; only a human detaching the conductor recovers full history).
 *
 * Subclasses (`NaiveCompactionConductor`, `HandoffConductor`) supply:
 *   - `systemPrompt` / `priorTag` — the completion's system instruction and the tag name a prior
 *     round's text is wrapped in (`previous-summary` / `previous-handoff`).
 *   - `firstPassInstruction()` / `recursiveInstruction()` — the one-line mode preamble appended
 *     after the `<conversation>` (and, on a recursive round, `<${priorTag}>`) wrapper.
 *   - `formatText(count, body)` — the count-preamble wrapper for a freshly-completed result.
 *   - `emptyOutputMessage` / `windowTooTightMessage` / `rejectMessage` / `unavailableMessage` — the
 *     four sticky-status messages a failed attempt can surface (their wording genuinely differs —
 *     e.g. only `handoff`'s reject message includes the provider's real error text — so these stay
 *     subclass-owned rather than templated). `unavailableMessage` is the calm "no live model link"
 *     case (`isUnavailableError`, below); `rejectMessage` is every OTHER rejection.
 *   - `includeInGroup(b)` (optional, defaults to "every kind") — whether a given aged block may be
 *     swallowed into the non-recoverable group, or must be excluded (stays live on the wire,
 *     splitting the run around it). Neither shipped subclass overrides this today — both swallow
 *     every kind, matching main's original behavior.
 */
export abstract class AgedSummaryConductor extends ViewConductor {
	abstract readonly id: string;
	abstract readonly label: string;
	readonly description?: string;
	readonly locks?: readonly LockName[];
	readonly tailTokens?: number;

	// ── subclass hooks (the genuinely different ~10%) ───────────────────────────

	/** System instruction for the completion call. */
	protected abstract readonly systemPrompt: string;
	/** Tag name a prior round's committed text is wrapped in when building a recursive prompt
	 *  (e.g. `"previous-summary"` / `"previous-handoff"`) — also neutralized, alongside
	 *  `"conversation"`, against a sentinel-breakout payload. */
	protected abstract readonly priorTag: string;
	/** One-line instruction appended after `<conversation>` on the FIRST round (no prior text). */
	protected abstract firstPassInstruction(): string;
	/** One-line (or multi-line) instruction appended after `<conversation>` on a RECURSIVE round
	 *  (a prior round's text already exists, wrapped in `<${priorTag}>`). */
	protected abstract recursiveInstruction(): string;
	/** Wrap a freshly-completed result with its count preamble (e.g. `"[Compacted summary of N
	 *  earlier messages]\n\n${body}"`). */
	protected abstract formatText(count: number, body: string): string;
	/** Sticky status when the completion resolved with empty/whitespace-only text. */
	protected abstract emptyOutputMessage(count: number): string;
	/** Sticky status when the context window leaves no room to reserve useful output. */
	protected abstract windowTooTightMessage(inputTokens: number, contextWindow: number): string;
	/** Sticky status when the completion promise rejected for a GENUINE reason (network error,
	 *  provider error, abort, …) — i.e. `isUnavailableError(err)` was false. Never called for a
	 *  no-live-model-link rejection; see `unavailableMessage` for that case. */
	protected abstract rejectMessage(err: unknown): string;
	/** Sticky status when the completion promise rejected specifically because the session has no
	 *  live model link (`isUnavailableError(err)` was true) — mirrors main's `host.can("complete")`
	 *  pre-check message. Unlike `rejectMessage`, this case also clears `lastAttemptKey` (see
	 *  `launchCompletion`'s reject handler) so the very next pass retries automatically once the
	 *  link returns, without waiting for genuinely new content to age in. */
	protected abstract unavailableMessage(): string;
	/** May `b` be swallowed into the non-recoverable summary group? Default: every kind. Excluded
	 *  blocks still feed the prompt as CONTEXT (via `newlyAged`) — they are only ever excluded from
	 *  actually being folded away, splitting the group run around them. */
	protected includeInGroup(_b: ViewBlock): boolean {
		return true;
	}

	/**
	 * The EXCLUSIVE upper index of the region this conductor may summarize — `agedRegion` and
	 * `emitCoverageGroup` walk blocks `[0, agedBoundaryIndex)`. Default: the host's protected-tail
	 * boundary (both shipped subclasses summarize everything older than the tail, main parity). A
	 * subclass with its own banding (triptych's thirds) overrides this to a NARROWER boundary; it must
	 * never return an index past `view.protectedFromIndex` (the protected tail is not this
	 * conductor's to summarize — `Truth` would clamp the group anyway, but the accounting here
	 * assumes the boundary is honest).
	 */
	protected agedBoundaryIndex(view: ConductorView): number {
		return view.protectedFromIndex;
	}

	/**
	 * The text a block contributes to the completion prompt (`buildPrompt`). Default: the block's
	 * full original text. A subclass that has already compressed a block (triptych's skeletons)
	 * overrides this to feed the compressed form instead — the conversation as the agent actually
	 * experienced it, and a much smaller prompt.
	 */
	protected promptTextOf(b: ViewBlock): string {
		return (b.text ?? "").trim();
	}

	// ── shared instance state ────────────────────────────────────────────────────

	/** The current completion result (with its subclass-formatted count preamble). Null until the
	 *  first completion succeeds. */
	protected text: string | null = null;

	/**
	 * The block ids currently represented by `text` — the monotonic "already summarized" set.
	 * Grows only within a session (replaced wholesale by each successful completion's full aged
	 * snapshot); cleared on attach. The group covers `coveredIds ∩ aged region ∩ includeInGroup`.
	 */
	protected coveredIds: Set<string> = new Set();

	/** AbortController for the current in-flight completion, or null when idle. */
	private inflight: AbortController | null = null;

	/**
	 * A stable key for the NEWLY AGED block set most recently ATTEMPTED. Keyed on `newlyAged` ids
	 * (NOT the full aged set) so a pure SHRINK of the aged set (e.g. a human pins an old block)
	 * does not change the key and does not relaunch; a genuinely new aged block does.
	 */
	private lastAttemptKey = "";

	/**
	 * A STICKY, human-visible failure message from the most recent attempt (provider rejection,
	 * empty output, or a window too tight to attempt). Null when the last attempt succeeded or none
	 * has run. It survives subsequent `conduct()` passes on purpose: a completion failure lands in
	 * the async reject handler, out of band from the model call, so the only way the human learns
	 * it broke is a status that is not wiped by the next pass. Cleared exactly when a genuine retry
	 * launches or a result commits — every `conduct()` path that would otherwise bare-clear the
	 * status bar calls `surfaceIdleStatus()` instead, so a failure is never erased before it is seen.
	 *
	 * PROTECTED (not private) so a subclass with its own out-of-band failure source can join the
	 * same sticky mechanism instead of racing it — triptych's skeleton-engine init failure writes
	 * here so an idle pass surfaces it rather than wiping a bare `setStatus` (adversarial-review
	 * finding: a subclass status set outside this field was cleared by the very next idle pass).
	 */
	protected failureStatus: string | null = null;

	/**
	 * Wire tokens the most recently COMMITTED pass actually removed (`liveTokens` before its ops
	 * applied minus after). Null until one completes — and a FAILED attempt never sets it, so a
	 * provider error can never look like an unproductive pass. Read only by the back-off in
	 * `conduct()`.
	 */
	private lastPassSaving: number | null = null;

	/** Σ full tokens of the aged region the most recently COMMITTED pass was handed — the bar a
	 *  refill has to clear before an unproductive conductor spends another model call. */
	private lastPassAgedTokens = 0;

	// ── lifecycle ────────────────────────────────────────────────────────────────

	/** A conductor lifetime starts fresh on attach — don't let state from a prior session leak into
	 *  the next one, even if the same instance is re-attached. */
	attach(host: ConductorHost): void {
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.text = null;
		this.coveredIds = new Set();
		this.lastAttemptKey = "";
		this.failureStatus = null;
		this.lastPassSaving = null;
		this.lastPassAgedTokens = 0;
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
		// AGED REGION: every block older than the protected working tail that is not human-held and
		// not already inside a FOREIGN (non-this-conductor) group. ALL kinds are included here — the
		// per-kind exclusion (`includeInGroup`) only affects which of these may be swallowed into the
		// group, not which are aged/fed to the prompt as context.
		const aged = this.agedRegion(view);

		// Degenerate config / empty session: nothing to manage. Hold any existing result.
		if (view.budget <= 0 || view.blocks.length === 0) {
			return this.text !== null ? this.emitCoverageGroup(view) : [];
		}

		// If a completion is in-flight, hold the current state — never launch a second.
		if (this.inflight !== null) return this.emitCoverageGroup(view);

		// VISIBLE WINDOW: what the model actually receives right now — `Truth.stats().liveTokens`,
		// surfaced as `view.liveTokens`. This is the AUTHORITATIVE number and the only one the
		// trigger reads (#90 review, sol5.6 P1 #1). It already incorporates every term a conductor-
		// side reconstruction cannot see: per-run group wire costs (`Truth.groupLiveTokens` /
		// `runWireTok`), stragglers left live inside a group, human folds, and — the term that broke
		// the old `rawTotal − savedTokens` formula — a DROP run the wire's role-validity floor
		// degraded into a PAID recap stub (`computeDegradedDropRuns`, core/wire.ts). That stub costs
		// ~25 tokens per degraded run REGARDLESS of run size, so a heavily fragmented aged region
		// (many tiny runs) made the old formula under-count the true wire without bound and starve
		// the trigger. Deriving the number instead of reading it was the bug; there is no separate
		// "saved tokens" bookkeeping left to drift.
		const visible = view.liveTokens;
		// Trigger on the EFFECTIVE cap, not raw budget: a mid-session swap to a smaller-window model
		// can leave `budget` oversized relative to `contextWindow` for one hook tick (the extension
		// clamps it back down, but defense in depth here means this conductor never depends on that
		// happening first). Never widens the cap — a known, smaller window only ever tightens it.
		const cap = view.contextWindow != null ? Math.min(view.budget, view.contextWindow) : view.budget;
		const overThreshold = visible >= cap * TRIGGER;

		// What is genuinely new since the last successful completion.
		const newlyAged = aged.filter((b) => !this.coveredIds.has(b.id));

		// Nothing aged and no prior result → nothing to do, clear to raw.
		if (aged.length === 0 && this.text === null) {
			this.surfaceIdleStatus();
			return [];
		}

		// PAID-RETRY BACK-OFF (#90 review round 2). Honest accounting means a conductor whose aged
		// region has nothing left worth collapsing sits permanently over the high-water mark. Every
		// turn then adds a newly-aged block, which changes `attemptKey` and would launch another
		// billed `host.complete()` call for the same nothing, forever. So: once a COMMITTED pass has
		// failed to shrink the wire (`lastPassSaving <= MIN_PASS_SAVING` — measured, not guessed, from
		// `liveTokens` either side of that pass's own ops), stop relaunching on mere attempt-key
		// drift. The gate re-opens on genuine REFILL: newly-aged content exceeding everything the
		// unproductive pass was already handed, which is the point at which the region has plausibly
		// grown a collapsible run it did not have before. A productive pass leaves this wide open, so
		// the healthy path is unchanged. The gate is deliberately blind to content FREED without
		// refill (e.g. a pin lifted mid-latch): it stays shut until new tokens age in, trading a
		// missed compaction opportunity for never re-billing on a region that already failed once.
		const productive = this.lastPassSaving === null || this.lastPassSaving > MIN_PASS_SAVING;
		const refilled = sumTokens(newlyAged) > this.lastPassAgedTokens;

		// Trigger only when the VISIBLE window is at/over the high-water mark AND there are
		// newly-aged blocks to fold in. Below the mark, or with nothing new, HOLD: re-emit the
		// existing group (or clear to raw if no result yet).
		const needsRun = overThreshold && newlyAged.length > 0 && (productive || refilled);
		if (!needsRun) {
			this.surfaceIdleStatus();
			return this.text !== null ? this.emitCoverageGroup(view) : [];
		}

		// Gate the launch on a stable signature of the NEWLY AGED set being attempted. Prevents
		// relaunching after a rejection on the SAME newly-aged set, and relaunching when the aged
		// set merely SHRINKS (a shrink does not change newlyAged ids). A genuinely new aged block
		// changes newlyAged → new key → retry is allowed.
		const attemptKey = newlyAged
			.map((b) => b.id)
			.sort()
			.join("\0");
		if (attemptKey === this.lastAttemptKey) {
			this.surfaceIdleStatus();
			return this.text !== null ? this.emitCoverageGroup(view) : [];
		}

		// LAUNCH a background completion (which may DECLINE if the window is too tight — see
		// launchCompletion). Snapshot the aged ids NOW so the async resolve handler commits the
		// result against exactly the blocks it summarized, regardless of what the view looks like
		// when it resolves. `view.contextWindow` is threaded in so the request reserves output room
		// against the real window.
		this.launchCompletion(aged, newlyAged, attemptKey, view.contextWindow);

		// Hold while the completion is in-flight: re-emit the existing group if one is already
		// applied, or null on the very first trip (no prior result yet — the ONE correct use of
		// null: genuinely still thinking, nothing applied).
		return this.emitCoverageGroup(view);
	}

	// ── helpers ───────────────────────────────────────────────────────────────────

	/**
	 * Ids currently inside a FOLDED group this conductor did NOT create. Every conductor-proposed
	 * op runs under actor `"auto"` (`ConductorHost.propose` → `Truth.apply(ops, "auto", …)`, see
	 * `ViewConductor.applyDesired`), so `g.by !== "auto"` reliably means "a human made this group"
	 * — the only kind of FOREIGN group an exclusive conductor like this can encounter.
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
	 * The aged region: every block older than the protected working tail that is not human-held,
	 * not BOLTED, and not already inside a FOREIGN group. All other kinds included (per-kind
	 * group-eligibility is decided separately by `includeInGroup`, applied only where a block would be
	 * folded away).
	 *
	 * BOLTED (`isBolted` — today the `system` prompt block, which sits at index 0 and is therefore in
	 * EVERY aged prefix) is excluded here, at the source, for two independent reasons. First, its text
	 * must never be fed to the summarizing completion: the model already receives the system prompt
	 * verbatim on every request, so summarizing it is pure waste and invites the summary to
	 * paraphrase the harness's own instructions back at it. Second — and this is the one that would
	 * lose data — `coveredIds` is built from exactly this set, and `emitCoverageGroup` walks the aged
	 * prefix turning covered blocks into contiguous runs. A run that started at index 0 would include
	 * the system block, and `Truth.opGroup` refuses such a range WHOLE with the `bolted` clamp: the
	 * summary-bearing carrier would be rejected while a sibling DROP run still commits, which is
	 * precisely the "content removed with nothing standing in for it" failure the run-level exclusions
	 * exist to prevent. Filtering here makes the bolted block a run SPLITTER (like a held block)
	 * instead — the run simply starts at index 1, and nothing else changes.
	 */
	private agedRegion(view: ConductorView): ViewBlock[] {
		const foreign = this.foreignGroupedIds();
		const aged: ViewBlock[] = [];
		const boundary = Math.min(this.agedBoundaryIndex(view), view.protectedFromIndex);
		for (let i = 0; i < boundary && i < view.blocks.length; i++) {
			const b = view.blocks[i];
			if (!b.held && !isBolted(b) && !foreign.has(b.id)) aged.push(b);
		}
		return aged;
	}

	/**
	 * Emit `text` as `group` command(s) covering the covered survivors in the aged prefix that are
	 * also `includeInGroup`-eligible. Re-derived from the LIVE view on every call:
	 *   - A survivor is a block in `coveredIds` that is still in the aged prefix, not held, not
	 *     inside a FOREIGN group, and `includeInGroup(b)`. A block this conductor has "covered"
	 *     (fed to the model at least once) but which is NOT group-eligible (only possible if a
	 *     subclass overrides `includeInGroup` to exclude a kind) is never a survivor here — it
	 *     stays live and forces the run to split.
	 *   - Runs are the MAXIMAL CONTIGUOUS spans of survivors, found by walking the FULL aged prefix
	 *     (including held/foreign-grouped/excluded blocks) so any of those SPLIT a run rather than
	 *     being spanned by it.
	 *   - Each surviving run becomes one `group(first, last, digest)` unless a run-level exclusion
	 *     below keeps it out; no run proposed → `[]` (clear to raw; lossless).
	 *
	 * ONLY THE FIRST EMITTED RUN CARRIES `text` (issue #90): a held/pinned block or a foreign group
	 * can fragment the aged prefix into K > 1 survivor runs, and every run used to get the FULL
	 * summary as its digest — the wire then carried K copies of the same text while the trigger
	 * charged it once. Every run after the first instead gets digest `""` — the group-op
	 * vocabulary's explicit DROP sentinel (`Truth.isDropGroup` / `core/ops.ts`'s `group.summary`
	 * doc: `null`/`""` → no wire message at all), not the default-recap `undefined` would trigger.
	 * K = 1 (the common case, no fragmentation) is unaffected: the single run still gets the full
	 * `text` digest, byte-identical to before that fix.
	 *
	 * THREE RUN-LEVEL EXCLUSIONS (#90 review). An excluded run is simply not proposed — its blocks
	 * stay live exactly as a held/foreign block already keeps itself out of a run — so all three are
	 * lossless, and all three are re-evaluated from the live view every pass:
	 *
	 *   1. NOT A FIXED POINT OF THE HOST'S RANGE SNAP. `Truth.opGroup` does not group the ids it is
	 *      handed: it groups `snappedRange(first, last)`, which walks each boundary OUTWARD over
	 *      blocks sharing its `messageKey` — sibling parts of the same assistant message that this
	 *      walk deliberately EXCLUDED. Vetting the run while Truth applies a wider set is a hole big
	 *      enough to lose data through: a snapped-in HELD sibling trips `opGroup`'s human-override
	 *      clamp, and a snapped-in `tool_call` whose result is outside flips the carrier verdict —
	 *      either way the carrier is rejected while a sibling DROP commits (exclusion 2's failure
	 *      mode, reached around the back). So each run is first trimmed INWARD to the largest
	 *      sub-window that `snappedRange` leaves alone (`snapToMessageAtoms`, mirroring
	 *      `conductors/ws/thermocline/policy.ts`'s `safeRunFromUnits`), and THAT window is both what
	 *      gets vetted and what gets proposed — so the group Truth applies is byte-identical to the
	 *      one judged here. A run that shrinks to nothing is dropped entirely.
	 *   2. NO VIABLE CARRIER (P1 #2 — silent data loss). `Truth.opGroup` rejects a group whose run
	 *      has nothing the wire may actually remove (`"nothing collapses (all stragglers)"` — e.g. a
	 *      run holding a `tool_call` whose paired `tool_result` is held OUTSIDE it). `Truth.apply`
	 *      validates each op INDEPENDENTLY and `ViewConductor.applyDesired` silently drops the
	 *      failures, so a rejected FIRST run (the summary carrier) alongside an accepted sibling
	 *      DROP removed content from the wire with no summary anywhere. Running the SAME fixpoint
	 *      `Truth.classifyGroup` runs (`collapsibleMessageKeys`, core/groupShape.ts — not a
	 *      re-derivation) BEFORE proposing means a doomed carrier is never proposed, so no sibling
	 *      drop is ever built on a summary that will not commit. Note the coupling: if the first run
	 *      is excluded, `text` moves to the first run that IS viable.
	 *   3. A DROP THAT COSTS MORE THAN IT SAVES (P1 #1 — the wire growing). The wire's role-validity
	 *      floor (`computeDegradedDropRuns`, core/wire.ts) turns a DROP run into a paid recap stub
	 *      when removing it would weld two same-role neighbors, at a cost that is ~flat per run
	 *      regardless of run size. Under heavy fragmentation (many tiny runs) that turned
	 *      "compaction" into net wire GROWTH. `dropEconomics` below compares what the drop actually
	 *      removes against what it can actually cost; a drop that cannot pay for itself is not made.
	 *      The summary CARRIER is exempt — it is this conductor's entire product, and a REPLACE run
	 *      is never degraded — so growth stays bounded by one summary's own cost.
	 *
	 * Returns:
	 *   - null  → no result yet (used ONLY while a first-trip completion is in-flight).
	 *   - []    → nothing worth (or able to) collapse (clear to raw; lossless).
	 *   - [...] → one `group` command per proposed run — the first carries `text`, every subsequent
	 *             one carries `""` (DROP).
	 */
	private emitCoverageGroup(view: ConductorView): Command[] | null {
		if (this.text === null) return null;

		// A run is a MAXIMAL CONTIGUOUS index span of survivors — contiguous by construction, so the
		// snap below never has to consider an interior hole.
		const foreign = this.foreignGroupedIds();
		const runs: Array<[number, number]> = [];
		let start = -1;
		const pfi = Math.min(this.agedBoundaryIndex(view), view.protectedFromIndex, view.blocks.length);
		for (let i = 0; i < pfi; i++) {
			const b = view.blocks[i];
			if (this.coveredIds.has(b.id) && !b.held && !foreign.has(b.id) && this.includeInGroup(b)) {
				if (start === -1) start = i;
			} else if (start !== -1) {
				runs.push([start, i - 1]);
				start = -1;
			}
		}
		if (start !== -1) runs.push([start, pfi - 1]);

		const cmds: Command[] = [];
		for (const [runStart, runEnd] of runs) {
			const snapped = this.snapToMessageAtoms(view, runStart, runEnd); // exclusion 1
			if (!snapped) continue;
			const members = view.blocks.slice(snapped[0], snapped[1] + 1);
			// Exclusion 2. `requireDurable: true` matches the live host this conductor always runs
			// under (`Truth.wireAttached` is set for every live pi session); it is also the STRICTER
			// of the two verdicts, so a run judged viable here is viable under either — the direction
			// that cannot lose data. An empty removable set is exactly `!hasCollapsibleCarrier`; the
			// set itself is what exclusion 3 needs, so it is computed once.
			const removable = collapsibleMessageKeys(members, true);
			if (removable.size === 0) continue;
			// Exclusion 3 applies only to DROP runs — the carrier always commits (see the doc above).
			if (cmds.length > 0) {
				const { saving, cost } = this.dropEconomics(members, removable);
				if (saving <= cost) continue;
			}
			cmds.push({ kind: "group", ids: [members[0].id, members[members.length - 1].id], digest: cmds.length === 0 ? this.text : "" });
		}
		return cmds;
	}

	/**
	 * Trim `[start..end]` INWARD to the largest sub-window that is a FIXED POINT of `Truth`'s
	 * `snappedRange`: a window neither of whose boundary messages continues past it. A run is a
	 * contiguous index span with no interior hole, so "no boundary straddles" is the whole condition
	 * (`policy.ts`'s `safeRunFromUnits` additionally checks for holes because its units can skip
	 * blocks). Shrinks the FRONT first when the front message straddles, otherwise the back — same
	 * order as that function. Null when nothing survives.
	 */
	private snapToMessageAtoms(view: ConductorView, start: number, end: number): [number, number] | null {
		const keyAt = (i: number): string => messageKey(view.blocks[i].id);
		let lo = start;
		let hi = end;
		while (lo <= hi) {
			const frontStraddles = lo > 0 && keyAt(lo - 1) === keyAt(lo);
			const backStraddles = hi < view.blocks.length - 1 && keyAt(hi + 1) === keyAt(hi);
			if (!frontStraddles && !backStraddles) return [lo, hi];
			if (frontStraddles) lo++;
			else hi--;
		}
		return null;
	}

	/**
	 * What DROPPING `members` would actually save, against the most it could actually cost.
	 *
	 * SAVING is only the members the wire may genuinely remove (`removable`, from the shared
	 * fixpoint). A STRAGGLER — a message the tool-pair fixpoint demoted — stays live at full cost
	 * inside the group (`Truth.groupLiveTokens` charges it exactly that), so counting it as saved
	 * would overstate the drop and is precisely how a "worth it" verdict could approve a group that
	 * grows the wire.
	 *
	 * COST is one role-floor recap stub per COLLAPSED SUB-RUN, not one per group: an interior
	 * straggler splits a group into several runs (`GroupShape.collapsedRuns`), and
	 * `computeDegradedDropRuns` degrades each independently, so N sub-runs can cost N stubs. Each
	 * stub is priced in ORIGINAL WIRE units from the EXACT text `applyPlan` synthesizes
	 * (`roleFloorRecap`, exported from `core/wire.ts` for this reason) plus the same
	 * `BLOCK_OVERHEAD` framing `Truth.runWireTok` charges it. `ViewBlock.rawTokens` keeps this sign
	 * check immune to provider calibration and its per-item rounding; pressure/budget decisions
	 * remain calibrated everywhere else. The floor's real verdict depends on every other run in the
	 * wire at once, so this is deliberately the WORST case: it can leave a small saving on the table,
	 * never cause growth.
	 * The group id is the one `Truth.opGroup` will mint (`g:<first member id>`) — exact, because the
	 * proposed member set is now snap-stable (exclusion 1).
	 */
	private dropEconomics(members: readonly ViewBlock[], removable: ReadonlySet<string>): { saving: number; cost: number } {
		const groupId = `g:${members[0].id}`;
		let saving = 0;
		let cost = 0;
		let runMessages = 0; // distinct message keys in the collapsed sub-run currently open
		let prevKey: string | null = null;
		const closeRun = (): void => {
			if (runMessages === 0) return;
			cost += estTokens(roleFloorRecap(groupId, runMessages)) + BLOCK_OVERHEAD;
			runMessages = 0;
			prevKey = null;
		};
		for (const b of members) {
			const k = messageKey(b.id);
			if (!removable.has(k)) {
				closeRun(); // a straggler ends the run and keeps its own tokens live
				continue;
			}
			saving += b.rawTokens ?? b.tokens;
			if (k !== prevKey) {
				runMessages++;
				prevKey = k;
			}
		}
		closeRun();
		return { saving, cost };
	}

	/** Surface the sticky failure status (or clear the bar when there is none). Used in every
	 *  `conduct()` path that would otherwise bare-`setStatus(null)`, so a completion failure set out
	 *  of band in the async handlers is not erased before the human sees it. Cleared exactly when a
	 *  genuine retry launches (see `launchCompletion`) or a result commits. */
	private surfaceIdleStatus(): void {
		this.host.setStatus(this.failureStatus);
	}

	/** Neutralize a sentinel-breakout attempt against BOTH tags this conductor's prompt ever wraps
	 *  content in: the always-present `"conversation"` wrapper and the subclass's `priorTag`. */
	private neutralize(s: string): string {
		return neutralizeClosingTags(s, ["conversation", this.priorTag]);
	}

	/**
	 * Fire-and-forget: build the completion prompt and launch a `host.complete()` call. `conduct()`
	 * returns immediately after calling this; the result comes back via the resolve handler, which
	 * calls `this.rerun()` (`ViewConductor`'s local successor to the old `host.requestRerun()`) to
	 * schedule a fresh `conduct()` pass so the group takes effect immediately.
	 *
	 * @param agedBlocks    - all aged blocks at launch time (SNAPSHOT — don't use the view later).
	 * @param newlyAged     - subset not already in `coveredIds` (used to build the recursive prompt).
	 * @param attemptKey    - the sorted-join key of the NEWLY AGED set being attempted; stored to
	 *                        prevent relaunching the same newly-aged set after a rejection.
	 * @param contextWindow - the model's total context window (or null if unknown), used to reserve
	 *                        output room so `input + output` cannot overflow the window.
	 */
	private launchCompletion(agedBlocks: ViewBlock[], newlyAged: ViewBlock[], attemptKey: string, contextWindow: number | null): void {
		if (this.inflight !== null) return; // defensive: should never reach here while inflight

		// Snapshot the ids and count at LAUNCH TIME. The resolve handler closes over these so it
		// commits the result against exactly the blocks it summarized, regardless of what the view
		// looks like when it resolves.
		const launchedAgedIds = new Set(agedBlocks.map((b) => b.id));
		const launchedAgedTokens = sumTokens(agedBlocks); // the refill bar, recorded only if this pass commits
		// The count preamble claims "N earlier messages" FOLDED — count only blocks eligible for the
		// group. With the default `includeInGroup` (every kind) this is just `agedBlocks.length`; a
		// subclass that excludes a kind gets the count right without any extra bookkeeping here.
		const count = agedBlocks.filter((b) => this.includeInGroup(b)).length;

		const prompt = this.buildPrompt(newlyAged);

		// Record the attempt key (keyed on newlyAged ids) so a rejected OR declined completion does
		// NOT immediately relaunch for the same newly-aged set on the next conduct() tick.
		this.lastAttemptKey = attemptKey;

		// RESERVE output room against the context window. The host clamp bounds max-OUTPUT only, not
		// `input + output`, so a blind MAX_OUTPUT_TOKENS request overflows the window when the input
		// is large relative to it (the 0.9 trigger puts input near the budget). Derive the cap from
		// the actual input size. When the window is unknown (null), we cannot reserve — fall back to
		// MAX_OUTPUT_TOKENS and rely on the host's max-output clamp.
		let maxOutputTokens = MAX_OUTPUT_TOKENS;
		if (contextWindow != null && contextWindow > 0) {
			const inputTokens = this.host.countTokens(this.systemPrompt) + this.host.countTokens(prompt);
			const reserve = contextWindow - inputTokens - OUTPUT_SAFETY_MARGIN;
			if (reserve < MIN_OUTPUT_TOKENS) {
				// The aged-region input alone nearly fills the window — there is no room to write
				// anything useful. Decline deliberately with a visible, sticky status instead of
				// sending a request the provider will reject. The attempt key is already recorded
				// above, so we do not re-attempt until genuinely new content ages in.
				this.failureStatus = this.windowTooTightMessage(inputTokens, contextWindow);
				this.host.setStatus(this.failureStatus, { input: inputTokens, window: contextWindow });
				return;
			}
			maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS, reserve);
		}

		// A genuine attempt is underway: clear any prior failure and the status bar.
		this.failureStatus = null;
		this.host.setStatus(null);

		const controller = new AbortController();
		this.inflight = controller;

		this.host
			.complete({
				system: this.systemPrompt,
				prompt,
				maxOutputTokens,
				signal: controller.signal,
			})
			.then(
				(result) => {
					// Stale-completion guard: if this conductor was detached (or re-attached,
					// launching a new controller) while this promise was outstanding, `this.inflight`
					// no longer points at OUR controller. Bail without touching state — a stale
					// result must never overwrite a new session's state, and clearing `inflight` here
					// would clobber a fresh in-flight completion.
					if (this.inflight !== controller) return;
					const text = result.text.trim();
					if (!text) {
						// Empty output would collapse the aged context behind a header-only result.
						// Treat it as a failed attempt: preserve prior state and wait for genuinely
						// new aged content before retrying this same key.
						this.inflight = null;
						this.failureStatus = this.emptyOutputMessage(count);
						this.host.setStatus(this.failureStatus, { aged: count });
						return;
					}
					// Success: commit the new result. The group covers `coveredIds ∩ aged` (minus
					// anything `includeInGroup` excludes) and is re-derived from the live view every
					// pass by `emitCoverageGroup`, so it stays valid even if blocks shift, vanish, or
					// re-home across the protected boundary.
					this.inflight = null;
					this.failureStatus = null;
					// The wire immediately BEFORE this pass's ops apply — half of the productivity
					// measurement the paid-retry back-off in `conduct()` reads (see `lastPassSaving`).
					// Measured, never estimated: `rerun()` settles once the transaction's per-op results
					// are reconciled, so the "after" reading reflects what actually COMMITTED, clamps
					// and all.
					const liveBefore = this.host.stats().liveTokens;
					this.text = this.formatText(count, text);
					this.coveredIds = launchedAgedIds;
					// async (v2 propose); ops apply on invocation, results reconcile on a microtask
					void this.rerun().then(() => {
						this.lastPassSaving = liveBefore - this.host.stats().liveTokens;
						this.lastPassAgedTokens = launchedAgedTokens;
					});
				},
				(err) => {
					// Stale-completion guard (see above): a reject from a controller that is no
					// longer current must not clear a fresh in-flight completion. A detach/swap-abort
					// lands here too, and its controller is never current — so an abort never sets a
					// failure status (the human chose to stop it).
					if (this.inflight !== controller) return;
					this.inflight = null;
					if (isUnavailableError(err)) {
						// No live model link — the v2-contract analog of main's `host.can("complete")`
						// pre-check reporting unavailability BEFORE ever launching. Mirror its semantics
						// exactly: a calm, sticky "waiting for live model link" status, and — unlike a
						// genuine reject — clear `lastAttemptKey` rather than leaving it set. Main's
						// pre-check never recorded an attempt at all for this case, so the very next
						// conduct() pass (the next turn, or the extension's own next `context` hook
						// re-establishing a model) retries the SAME newly-aged set automatically, with
						// no need for genuinely new content to age in first.
						this.failureStatus = this.unavailableMessage();
						this.host.setStatus(this.failureStatus, { aged: count });
						this.lastAttemptKey = "";
					} else {
						this.failureStatus = this.rejectMessage(err);
						this.host.setStatus(this.failureStatus, { aged: count });
					}
				},
			);
	}

	/**
	 * Build the user-role prompt for the completion. The format spec lives in `systemPrompt`
	 * (identical for both passes); this only varies the input wrapper and the one-line mode
	 * preamble, both supplied by the subclass.
	 *
	 * FIRST round (`text == null`): `<conversation>` … `</conversation>` + `firstPassInstruction()`.
	 * Every newly-aged block is included verbatim (all kinds, labeled by role/kind) — INCLUDING
	 * kinds `includeInGroup` would later exclude from the fold, since they are still valid CONTEXT
	 * for the model even when they must stay live on the wire.
	 *
	 * RECURSIVE round (`text != null`): `<${priorTag}>` … `</${priorTag}>` + `<conversation>` …
	 * `</conversation>` + `recursiveInstruction()`. The originals already fed into a prior round are
	 * deliberately not re-read (recursive amnesia by design for the assistant/tool/thinking content
	 * that DID get folded away; see each subclass for why).
	 *
	 * INJECTION DEFENSE: block text, block labels, and the prior round's text are all interpolated
	 * inside `<conversation>` / `<${priorTag}>` tags. A tool_result carrying a literal closing tag
	 * (a web fetch or file read — attacker-influenceable) would otherwise break out of the data
	 * section and inject instructions into the completion call. `neutralize` breaks any such
	 * closing tag in interpolated content; `systemPrompt` is expected to declare everything inside
	 * those tags untrusted data, never instructions.
	 */
	protected buildPrompt(newlyAged: ViewBlock[]): string {
		const conversation = newlyAged
			.map((b) => {
				// Defense-in-depth: `blockLabel` interpolates `b.toolName`, which is provider/tool-
				// supplied data, not conductor-authored text. A real tool name can never contain a
				// closing tag in practice (provider tool-name charsets forbid it), so this is
				// unreachable today — but it costs nothing to run the label through the same
				// neutralizer as every other interpolated value instead of trusting the charset.
				const label = this.neutralize(blockLabel(b));
				const text = this.neutralize(this.promptTextOf(b));
				return text ? `[${label}]\n${text}` : `[${label}]`;
			})
			.join("\n\n");

		if (this.text !== null) {
			return [
				`<${this.priorTag}>`,
				this.neutralize(this.text),
				`</${this.priorTag}>`,
				"",
				"<conversation>",
				conversation,
				"</conversation>",
				"",
				this.recursiveInstruction(),
			].join("\n");
		}

		return ["<conversation>", conversation, "</conversation>", "", this.firstPassInstruction()].join("\n");
	}
}

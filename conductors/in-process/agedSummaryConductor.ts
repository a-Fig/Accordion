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
 * No Svelte, no `$state`, no engine imports. Types only from `../conductor/contract` and
 * `../conductor/view`.
 */
import { ViewConductor, type Command, type ConductorView } from "../../core/conductor/view";
import type { ConductorHost, LockName, ViewBlock } from "../../core/conductor/contract";

/** Fraction of budget at which a run triggers (high-water mark). Shared by both conductors. */
const TRIGGER = 0.9;

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
	 */
	private failureStatus: string | null = null;

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

		// The blocks already represented by `text` that are still in the aged region AND actually
		// eligible to be folded away (see `includeInGroup`). These are what the group covers, and
		// their tokens are the saving that shrinks the VISIBLE window below the raw baseline. A
		// covered-but-excluded block (were a subclass to override `includeInGroup` to exclude a
		// kind) contributes NOTHING here — it was never actually removed from the wire, so crediting
		// it as "saved" would understate the real visible window and starve the trigger.
		const survivors = aged.filter((b) => this.coveredIds.has(b.id) && this.includeInGroup(b));
		const savedTokens = this.text !== null ? Math.max(0, sumTokens(survivors) - this.textTokenCost()) : 0;

		// RAW baseline: Σ full token cost over EVERY block (aged or protected).
		const rawTotal = sumTokens(view.blocks);
		const visible = rawTotal - savedTokens;
		const overThreshold = visible >= view.budget * TRIGGER;

		// What is genuinely new since the last successful completion.
		const newlyAged = aged.filter((b) => !this.coveredIds.has(b.id));

		// Nothing aged and no prior result → nothing to do, clear to raw.
		if (aged.length === 0 && this.text === null) {
			this.surfaceIdleStatus();
			return [];
		}

		// Trigger only when the VISIBLE window is at/over the high-water mark AND there are
		// newly-aged blocks to fold in. Below the mark, or with nothing new, HOLD: re-emit the
		// existing group (or clear to raw if no result yet).
		const needsRun = overThreshold && newlyAged.length > 0;
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
	 * The aged region: every block older than the protected working tail that is not human-held and
	 * not already inside a FOREIGN group. All kinds included (per-kind group-eligibility is decided
	 * separately by `includeInGroup`, applied only where a block would be folded away).
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
	 * Emit `text` as `group` command(s) (digest = text) covering the covered survivors in the aged
	 * prefix that are also `includeInGroup`-eligible. Re-derived from the LIVE view on every call:
	 *   - A survivor is a block in `coveredIds` that is still in the aged prefix, not held, not
	 *     inside a FOREIGN group, and `includeInGroup(b)`. A block this conductor has "covered"
	 *     (fed to the model at least once) but which is NOT group-eligible (only possible if a
	 *     subclass overrides `includeInGroup` to exclude a kind) is never a survivor here — it
	 *     stays live and forces the run to split.
	 *   - If no survivors → `[]` (clear to raw; lossless).
	 *   - Otherwise emit one `group(first, last, digest)` per MAXIMAL CONTIGUOUS run of survivors,
	 *     walking the FULL aged prefix (including held/foreign-grouped/excluded blocks) so any of
	 *     those SPLIT the run rather than being spanned.
	 *
	 * Returns:
	 *   - null  → no result yet (used ONLY while a first-trip completion is in-flight).
	 *   - []    → no surviving covered blocks to cover (clear to raw; lossless).
	 *   - [...] → one `group` command per contiguous survivor run, digest = text.
	 */
	private emitCoverageGroup(view: ConductorView): Command[] | null {
		if (this.text === null) return null;

		const foreign = this.foreignGroupedIds();
		const cmds: Command[] = [];
		let runStart = -1;
		let runEnd = -1;
		let survivorCount = 0;
		const flush = (): void => {
			if (runStart === -1) return;
			cmds.push({ kind: "group", ids: [view.blocks[runStart].id, view.blocks[runEnd].id], digest: this.text! });
			runStart = -1;
			runEnd = -1;
		};
		const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
		for (let i = 0; i < pfi; i++) {
			const b = view.blocks[i];
			if (this.coveredIds.has(b.id) && !b.held && !foreign.has(b.id) && this.includeInGroup(b)) {
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

	/** Surface the sticky failure status (or clear the bar when there is none). Used in every
	 *  `conduct()` path that would otherwise bare-`setStatus(null)`, so a completion failure set out
	 *  of band in the async handlers is not erased before the human sees it. Cleared exactly when a
	 *  genuine retry launches (see `launchCompletion`) or a result commits. */
	private surfaceIdleStatus(): void {
		this.host.setStatus(this.failureStatus);
	}

	/** The token cost of the current `text`, via the host's tokenizer. Used only to compute the
	 *  VISIBLE window for the trigger. */
	private textTokenCost(): number {
		if (this.text === null) return 0;
		return this.host.countTokens(this.text);
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
					this.text = this.formatText(count, text);
					this.coveredIds = launchedAgedIds;
					void this.rerun(); // async (v2 propose); ops apply on invocation, results reconcile on a microtask
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
				const text = this.neutralize((b.text ?? "").trim());
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

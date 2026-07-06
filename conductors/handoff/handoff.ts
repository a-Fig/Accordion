/*
 * handoff.ts — the "Handoff (fresh start)" conductor.
 *
 * PURPOSE: This conductor simulates the OTHER thing a developer does when a coding session
 * runs long — not `/compact` (see the naive-compaction conductor for that foil), but the
 * hard reset: write a HANDOFF DOCUMENT, `/clear` the session, and paste the handoff into a
 * BRAND-NEW agent that has NO memory of the conversation. The fresh agent continues from the
 * handoff and NOTHING ELSE.
 *
 * That "and nothing else" is the whole point, and it is what makes this a DISTINCT strategy
 * rather than a re-skin of naive compaction:
 *
 *   - Naive compaction keeps a LARGE rolling working tail (the human's protected tail,
 *     ~20k tokens) verbatim and only summarizes the aged PREFIX. The agent always has plenty
 *     of recent raw context PLUS a summary of old stuff.
 *
 *   - A fresh start throws the working tail AWAY. When you `/clear` and reseed, you do NOT
 *     carry over your last 20k of live tool output and reasoning — you carry over ONLY what
 *     the handoff author chose to write down. So this conductor OWNS a ZERO inherited tail
 *     (`HANDOFF_TAIL_TOKENS = 0`) and folds the WHOLE current conversation into ONE handoff
 *     document. The visible window collapses to the handoff itself and then rebuilds with new
 *     post-handoff turns — a hard-reset sawtooth, not naive compaction's gentle curve.
 *
 * To disable the inherited tail the conductor must hold the `tail-size` lock (ADR 0011) with
 * `tailTokens = 0`; that is the essential mechanical difference from naive compaction,
 * which deliberately leaves `tail-size` UNLOCKED so the human keeps a big verbatim tail.
 * Locking `tail-size` here is not a power grab — it IS the simulation. Without it the human's
 * 20k tail would defeat the "fresh start" entirely and this conductor would be indistinguishable
 * from naive compaction.
 *
 * LOSSY AND RECURSIVE, exactly like the naive-compaction foil — and for the same honest
 * reasons, because a real handoff chain has the same failure modes:
 *   - Lossy: the folded blocks collapse into ONE group whose digest is the handoff. There is
 *     no `{#code FOLDED}` tag, so the agent cannot `unfold` to recover the originals — a fresh
 *     agent genuinely does not have them. (The human can always DETACH to recover full history;
 *     that asymmetry is Accordion being Accordion.)
 *   - Recursive: each subsequent handoff is written from the PRIOR handoff + only the new work
 *     since — never the originals already discarded. Successive handoffs compound loss the same
 *     way successive `/compact`s do, because a real fresh-start chain also only ever sees the
 *     last handoff, never the raw sessions behind it. This compounding is the point of the foil.
 *
 * SHAPE — a close cousin of the naive-compaction conductor (which is itself a cousin of
 * sliding-window). Same single-`group`-over-the-aged-run mechanism, same visible-window
 * hysteresis, same in-flight / stale-completion / attempt-key guards. Two things differ:
 *   1. It holds the `tail-size` lock with `tailTokens = 0` (naive compaction holds neither).
 *   2. The completion prompt is a HANDOFF DOCUMENT for a cold successor agent, not a
 *      compaction summary appended to live context (see `HANDOFF_SYSTEM`).
 *
 * TRIGGER — the same visible-window hysteresis naive compaction uses. `view.liveTokens` is the
 * RAW, fully-unfolded size (the host clears conductor folds every pass), so it only grows; a
 * naive `liveTokens >= 90%` test would re-trigger forever once first crossed. Instead the
 * conductor tracks the token saving its handoff group provides and triggers on the VISIBLE
 * window: `visible = liveTokens − (Σ survivor tokens − handoff token cost)`. When
 * `visible >= 90%` of budget AND there are newly-aged blocks to fold in, it re-writes the
 * handoff; otherwise it HOLDS, re-emitting the existing handoff group.
 *
 * USER MESSAGES ARE PRESERVED VERBATIM inside the handoff (Claude-Code `/compact` and every
 * good hand-written handoff do this): the system prompt reproduces every user message
 * word-for-word in an "## Original request" section, so the task the human actually asked for
 * survives every handoff intact. Only assistant reasoning degrades across the chain.
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

/** Fraction of budget at which a fresh handoff is written (high-water mark). */
const TRIGGER = 0.9;

/**
 * The inherited old-session tail this conductor OWNS via the `tail-size` lock. A literal fresh
 * start keeps NONE of the old session verbatim: the successor agent receives the handoff
 * document and only future post-handoff turns. `0` makes the host's protected boundary land at
 * `blocks.length`, so every current block is eligible to be folded into the handoff group.
 * This is the load-bearing difference from naive compaction (which rides the human's ~20k tail).
 */
export const HANDOFF_TAIL_TOKENS = 0;

/**
 * Soft cap on handoff output tokens. Sized like naive compaction's summary cap: a handoff
 * compacts roughly 20k–200k tokens of history at a time and must retain enough to let a cold
 * agent continue, so 8k gives room for a genuinely useful briefing while still being a large
 * reduction (~2.5x at 20k of input, ~25x at 200k). The host clamps the request to the model's
 * own max-output ceiling; over-long output is truncated (finish-reason "length") and used
 * as-is — acceptable for a lossy foil.
 */
const MAX_HANDOFF_TOKENS = 8000;

/**
 * System prompt for the handoff completion. This is the FRESH-START voice: it addresses the
 * model as the AUTHOR of a handoff for a successor that will have NOTHING but this document.
 * That framing (vs. naive compaction's "summarize aged history that will sit above live
 * context") is what makes the output a handoff rather than a compaction summary.
 *
 * Structure mirrors a good hand-written engineering handoff — Original request (verbatim),
 * Task, Current state, Next steps, Key files, Gotchas, How to resume — rather than the
 * compaction template's Goal/Progress/Key decisions/Critical context/Relevant files. The one
 * rule shared with `/compact`: user messages reproduced VERBATIM, so the human's actual ask
 * survives every handoff intact.
 */
export const HANDOFF_SYSTEM = `\
You are writing a HANDOFF DOCUMENT for a fresh AI coding agent that will continue this work \
in a NEW session. The new agent has NO memory of the conversation so far and will see ONLY \
this document — the original messages are gone. Write everything it needs to pick up exactly \
where this session left off, and nothing it does not.

Do NOT continue the conversation. Do NOT answer any question in the conversation. ONLY output \
the handoff document.

Write it as if briefing a competent colleague who is smart but has zero context. Be concrete: \
real file paths, real function/command names, real error messages. Assume nothing carries over \
except what you write here.

ORIGINAL REQUEST IS SACRED. Reproduce EVERY user message VERBATIM, in order, exactly as \
originally written, in the "## Original request" section. Do not paraphrase, abbreviate, \
summarize, or omit a single user message — the fresh agent must see the human's real ask \
word-for-word. (Assistant text, thinking, tool calls, and tool results ARE synthesized; only \
user messages are preserved verbatim.)

Produce your output in EXACTLY this structure — no prose outside the sections. Keep every \
section even when empty; write "(none)" where nothing applies:

## Original request
Every user message from the session so far, reproduced verbatim, in order, each clearly \
separated. If there are no user messages, write "(none)".

## Task
One or two sentences: what is the overall objective the fresh agent is being handed?

## Current state
What is DONE and known-good so far — files changed, commands run, results verified, decisions \
made and WHY. Be specific enough that the fresh agent trusts it without re-deriving it.

## Next steps
The concrete actions the fresh agent should take next, in order. Start with the very next thing \
to do.

## Key files & locations
- {path}: why it matters / what is in it. List files read, written, or central to the task. \
Write "(none)" if none.

## Gotchas & constraints
Non-obvious things that will bite a fresh agent: environment quirks, invariants, hard scope \
limits, failed approaches not to repeat, API-key PATTERNS (never actual secret values). Err on \
the side of including anything surprising to lose.

## How to resume / verify
How the fresh agent should re-orient and confirm the current state before continuing (commands \
to run, what "working" looks like).

Be terse everywhere EXCEPT the verbatim original request, which must be complete. Omit \
pleasantries and meta-commentary. The output goes directly into the fresh agent's context.`;

export class HandoffConductor implements Conductor {
	readonly id = "handoff";
	readonly label = "Handoff (fresh start)";

	/**
	 * Involvement locks (ADR 0011). This conductor is EXCLUSIVE over all three steering
	 * controls:
	 *   - `human-steering` + `agent-unfold` — same rationale as naive compaction: the human's
	 *     hand overrides and the agent's `unfold` cannot fight the handoff group while it is
	 *     being rewritten, and `human-steering` keeps the aged region CONTIGUOUS so the single
	 *     `group` command covering it is always valid.
	 *   - `tail-size` — REQUIRED here (naive compaction pointedly omits it). Owning the tail is
	 *     the simulation: a fresh start keeps no verbatim tail from the killed session, unlike
	 *     the human's ~20k.
	 *     Under this lock the host drives `protectedFromIndex` from `tailTokens` below, so the
	 *     conductor folds the whole current conversation into the handoff.
	 *
	 * Being exclusive over all three triggers the one-time consent gate (ADR 0011); the human's
	 * recourse is always DETACH, which freezes the current view and inherits this conductor's
	 * tail into the human's `protectTokens` (so the boundary is stable across detach).
	 */
	readonly locks = ["human-steering", "agent-unfold", "tail-size"] as const;

	/**
	 * The protected tail this conductor declares while holding `tail-size` (ADR 0011). It is
	 * deliberately ZERO: the host protects nothing from the old session, so the whole current
	 * conversation is foldable into the handoff. This is the mechanical heart of the "fresh
	 * start": no inherited tail ⇒ one handoff-only context ⇒ a hard-reset sawtooth.
	 */
	readonly tailTokens = HANDOFF_TAIL_TOKENS;

	// ── instance state ─────────────────────────────────────────────────────────

	/** Injected by attach(); null until the conductor is attached. */
	private host: ConductorHost | null = null;

	/** The current handoff document (with its count preamble). Null until the first handoff completes. */
	private handoff: string | null = null;

	/**
	 * The block ids currently represented by the handoff — the monotonic "already handed off"
	 * set. Grows only within a session; cleared on attach. The handoff group covers
	 * `handedOffIds ∩ aged region`. Empty until the first handoff completes.
	 */
	private handedOffIds: Set<string> = new Set();

	// ── in-flight tracking ─────────────────────────────────────────────────────

	/** AbortController for the current in-flight completion, or null when idle. */
	private inflight: AbortController | null = null;

	/**
	 * A stable key for the NEWLY AGED block set most recently ATTEMPTED (a completion launched
	 * for it). Prevents re-launching the exact same newly-aged set after a rejected/failed
	 * completion, while still allowing a retry when genuinely new content ages in.
	 *
	 * Keyed on `newlyAged` ids (NOT the full aged set) so a pure SHRINK of the aged set does not
	 * re-launch. Set at launch; not cleared on rejection; irrelevant after success (the newly
	 * aged set becomes empty once `handedOffIds` grows to cover it).
	 */
	private lastAttemptKey: string = "";

	// ── lifecycle ──────────────────────────────────────────────────────────────

	attach(host: ConductorHost): void {
		// A conductor lifetime starts fresh on attach. Don't let a handoff or retry key from a
		// prior session leak into the next one, even if the same instance is re-attached.
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.handoff = null;
		this.handedOffIds = new Set();
		this.lastAttemptKey = "";
		this.host = host;
	}

	detach(): void {
		// Cancel any in-flight completion so a stale result can't call requestRerun() after
		// the conductor is detached.
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

		// AGED REGION: every block older than the conductor-owned protected boundary that is not
		// human-held and not already inside a group. With `tailTokens = 0`, that boundary is the
		// end of the session, so the first handoff can swallow the whole current conversation.
		// ALL kinds are included — the single handoff group and the host's whole-message snap +
		// pair-balance keeps the result wire-valid (a tool_call is never orphaned from its result).
		const aged = this.agedRegion(view);

		// Degenerate config / empty session: nothing to manage. Hold any existing handoff.
		if (view.budget <= 0 || view.blocks.length === 0) {
			return this.handoff !== null ? this.emitHandoffGroup(view) : [];
		}

		// If a completion is in-flight, hold the current state — never launch a second.
		if (this.inflight !== null) return this.emitHandoffGroup(view);

		// The blocks already in the handoff that are still in the aged region. These are what
		// the handoff group covers, and their tokens are the saving that shrinks the VISIBLE
		// window below the raw `liveTokens`.
		const survivors = aged.filter((b) => this.handedOffIds.has(b.id));

		// VISIBLE window = raw baseline minus the token saving the handoff group provides.
		// `view.liveTokens` is the RAW size (host clears conductor folds each pass), so without
		// subtracting the saving the 90% trigger would fire every pass once first crossed. Same
		// hysteresis computation as naive compaction / sliding-window.
		const savedTokens = this.handoff !== null
			? Math.max(0, sumTokens(survivors) - this.handoffTokenCost())
			: 0;
		const visible = view.liveTokens - savedTokens;
		const overThreshold = visible >= view.budget * TRIGGER;

		// What is genuinely new since the last successful handoff.
		const newlyAged = aged.filter((b) => !this.handedOffIds.has(b.id));

		// Nothing aged and no prior handoff → nothing to do, clear to raw.
		if (aged.length === 0 && this.handoff === null) {
			this.host.setStatus(null);
			return [];
		}

		// Trigger only when the VISIBLE window is at/over the high-water mark AND there are
		// newly-aged blocks to fold in. Below the mark, or with nothing new, HOLD: re-emit the
		// existing handoff group (or clear to raw if no handoff yet).
		const needHandoff = overThreshold && newlyAged.length > 0;
		if (!needHandoff) {
			this.host.setStatus(null);
			return this.handoff !== null ? this.emitHandoffGroup(view) : [];
		}

		// DEGRADE path: if the host cannot run completions (live model not connected), report
		// unavailability and preserve current state. No deterministic fallback — this conductor
		// is specifically the LLM-handoff simulation, so if the host cannot complete we wait
		// visibly rather than silently switching strategies.
		if (!this.host.can("complete")) {
			this.host.setStatus("Handoff unavailable — waiting for live model link", {
				aged: aged.length,
				fullness: Math.round((visible / view.budget) * 100),
			});
			return this.handoff !== null ? this.emitHandoffGroup(view) : [];
		}
		this.host.setStatus(null);

		// Gate the launch on a stable signature of the NEWLY AGED set. Prevents re-launching
		// after a rejection on the same set and when the aged set merely SHRINKS; a genuinely
		// new aged block changes the key → retry allowed.
		const attemptKey = newlyAged.map((b) => b.id).sort().join("\0");
		if (attemptKey === this.lastAttemptKey) {
			return this.handoff !== null ? this.emitHandoffGroup(view) : [];
		}

		// LAUNCH a background completion. Snapshot the aged ids NOW so the async resolve handler
		// commits the handoff against exactly the blocks it wrote from.
		this.launchCompletion(aged, newlyAged, attemptKey);

		// Hold while the completion is in-flight: re-emit the existing handoff group if one is
		// applied, or null on the very first trip (no prior handoff — the ONE correct use of
		// null: genuinely still thinking, nothing applied).
		return this.emitHandoffGroup(view);
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	/**
	 * The aged region: every block older than the conductor-owned protected boundary that is not
	 * human-held and not already inside a group. For this conductor's zero tail that is the whole
	 * current session; later, after a handoff exists, it is the prior handoff plus new work.
	 * All kinds included (the single handoff group swallows the region; the host pair-balances
	 * tool calls/results).
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
	 * Emit the handoff as `group` command(s) (digest = handoff) covering the handed-off
	 * survivors in the aged region. Re-derived from the LIVE view every call:
	 *   - A survivor is a block in `handedOffIds` still in the aged prefix and not held/grouped.
	 *   - No survivors → `[]` (clear to raw; lossless — the host resets all blocks to full
	 *     content this pass).
	 *   - Otherwise one `group(first, last, digest)` per MAXIMAL CONTIGUOUS run of survivors,
	 *     walking the FULL aged prefix (including held/grouped blocks) so a human-held block
	 *     SPLITS the run rather than being spanned. Under `human-steering` the aged region is
	 *     contiguous, so there is exactly ONE run → one handoff tile. A pre-existing held/grouped
	 *     block splitting the region yields one group per side, each carrying the handoff digest —
	 *     every survivor stays covered, none dropped.
	 *
	 * The host snaps each run outward to whole messages and refuses one whose snapped range
	 * reaches into the protected tail (`invalid-group` clamp) — refused runs' blocks simply stay
	 * live that pass (no data loss) and rejoin when the boundary clears.
	 *
	 * Returns:
	 *   - null  → no handoff yet (used ONLY while a first-trip completion is in-flight).
	 *   - []    → no surviving handed-off blocks to cover (clear to raw; lossless).
	 *   - [...] → one `group` command per contiguous survivor run, digest = handoff.
	 */
	private emitHandoffGroup(view: ConductorView): Command[] | null {
		if (this.handoff === null) return null;

		const cmds: Command[] = [];
		let runStart = -1;
		let runEnd = -1;
		let survivorCount = 0;
		const flush = (): void => {
			if (runStart === -1) return;
			cmds.push({
				kind: "group",
				ids: [view.blocks[runStart].id, view.blocks[runEnd].id],
				digest: this.handoff!,
			});
			runStart = -1;
			runEnd = -1;
		};
		const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
		for (let i = 0; i < pfi; i++) {
			const b = view.blocks[i];
			if (this.handedOffIds.has(b.id) && !b.held && !b.grouped) {
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
	 * The token cost of the current handoff, via the host's tokenizer when available, else a
	 * length/4 estimate. Used only to compute the VISIBLE window for the trigger.
	 */
	private handoffTokenCost(): number {
		if (this.handoff === null) return 0;
		if (this.host && this.host.can("countTokens")) return this.host.countTokens(this.handoff);
		return Math.ceil(this.handoff.length / 4);
	}

	/**
	 * Fire-and-forget: build the handoff prompt and launch a host.complete() call. conduct()
	 * returns immediately after calling this; the result comes back via the resolve handler,
	 * which calls host.requestRerun() to schedule a fresh conduct() pass.
	 *
	 * @param agedBlocks - all aged blocks at launch time (SNAPSHOT — don't use the view later).
	 * @param newlyAged  - subset not already in handedOffIds (used to build the recursive prompt).
	 * @param attemptKey - the sorted-join key of the NEWLY AGED set; stored to prevent
	 *                     re-launching the same set after a rejection.
	 */
	private launchCompletion(agedBlocks: ViewBlock[], newlyAged: ViewBlock[], attemptKey: string): void {
		// Safety: should never reach here while inflight, but guard defensively.
		if (this.inflight !== null) return;

		// Snapshot the ids and count at LAUNCH TIME. The resolve handler closes over these so it
		// commits the handoff against exactly the blocks it wrote from.
		const launchedAgedIds = new Set(agedBlocks.map((b) => b.id));
		const count = agedBlocks.length;

		const prompt = this.buildPrompt(newlyAged);

		// Record the attempt key (keyed on newlyAged ids) so a rejected completion does NOT
		// immediately re-launch for the same newly-aged set on the next conduct() tick.
		this.lastAttemptKey = attemptKey;

		const controller = new AbortController();
		this.inflight = controller;

		this.host!.complete({
			system: HANDOFF_SYSTEM,
			prompt,
			maxOutputTokens: MAX_HANDOFF_TOKENS,
			signal: controller.signal,
		}).then(
			(result) => {
				// Stale-completion guard: if this conductor was detached (or swapped and
				// re-attached, launching a new controller) while this promise was outstanding,
				// `this.inflight` no longer points at OUR controller. Bail without touching state —
				// a stale result must never overwrite the new session, and clearing `inflight`
				// here would clobber a fresh in-flight completion.
				if (this.inflight !== controller) return;
				const text = result.text.trim();
				if (!text) {
					// Empty output would collapse the whole session behind a header-only handoff.
					// Treat it as a failed attempt: preserve prior handoff/state and wait for
					// genuinely new aged content before retrying this same key.
					this.inflight = null;
					this.host?.setStatus("Handoff failed — model returned an empty document", {
						aged: count,
					});
					return;
				}
				// Success: commit the new handoff. The group covers `handedOffIds ∩ aged` and is
				// re-derived from the live view every pass by emitHandoffGroup, so it stays valid
				// even if blocks shift, vanish, or re-home across the protected boundary.
				this.inflight = null;
				this.handoff =
					`[Handoff from a previous session — ${count} earlier message${count === 1 ? "" : "s"} compacted into this briefing]\n\n` +
					text;
				this.handedOffIds = launchedAgedIds;
				// Re-run conduct() now so the handoff group takes effect immediately.
				this.host?.requestRerun();
			},
			(_err) => {
				// Stale-completion guard (see the resolve handler): a reject from a controller
				// that is no longer current must not clear a fresh in-flight completion.
				if (this.inflight !== controller) return;
				// Rejected (abort, network error, unknown model, etc.): clear inflight but leave
				// prior handoff/state intact. Do NOT immediately relaunch — the lastAttemptKey
				// guard ensures we only retry when genuinely new aged content arrives, preventing
				// a tight model-hammering loop on a persistent failure.
				this.inflight = null;
			},
		);
	}

	/**
	 * Build the user-role prompt for the handoff completion. The format spec lives in
	 * `HANDOFF_SYSTEM` (identical for both passes); this only varies the INPUT wrapper and the
	 * one-line mode preamble.
	 *
	 * FIRST handoff (handoff == null): `<conversation>` … `</conversation>` + "Write the handoff".
	 *
	 * RECURSIVE handoff (handoff != null): `<previous-handoff>` + `<conversation>` (new blocks
	 * only) + merge instructions. The originals already folded into the prior handoff are
	 * DELIBERATELY NOT re-read — this is the recursive amnesia the foil demonstrates: a real
	 * fresh-start chain only ever carries the last handoff forward, never the raw sessions behind
	 * it. The merge instructions are not a mitigation of that structural loss (the originals are
	 * gone, unfixable by any prompt); they only stop the model from silently dropping the prior
	 * handoff, and keep every verbatim user message carried forward.
	 */
	private buildPrompt(newlyAged: ViewBlock[]): string {
		const conversation = newlyAged
			.map((b) => {
				const label = blockLabel(b);
				const text = (b.text ?? "").trim();
				return text ? `[${label}]\n${text}` : `[${label}]`;
			})
			.join("\n\n");

		if (this.handoff !== null) {
			// Recursive path: feed the PRIOR HANDOFF + only the NEWLY AGED blocks.
			return [
				"<previous-handoff>",
				this.handoff,
				"</previous-handoff>",
				"",
				"<conversation>",
				conversation,
				"</conversation>",
				"",
				"Update the handoff in <previous-handoff> to account for the new work in <conversation>. PRESERVE all still-relevant details from the previous handoff; drop what is now stale or done; fold in the new facts. Move finished work into \"Current state\" and revise \"Next steps\" accordingly. Keep exact file paths, function names, and error messages. Carry forward every verbatim user message from the previous handoff and append the new user messages from the conversation — all still reproduced word-for-word in \"## Original request\".",
			].join("\n");
		}

		// First handoff.
		return [
			"<conversation>",
			conversation,
			"</conversation>",
			"",
			"Write the handoff document for the session history above.",
		].join("\n");
	}
}

// ── utilities ─────────────────────────────────────────────────────────────────

/** Sum the full token cost of a set of blocks. */
export function sumTokens(blocks: ViewBlock[]): number {
	let n = 0;
	for (const b of blocks) n += b.tokens;
	return n;
}

/**
 * A short human-readable label for a block, used when building the handoff prompt. Mirrors the
 * role labeling convention in the Transcript view.
 */
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

/*
 * bear2-hybrid.ts — the "Bear-2 hybrid" conductor (ADR 0015).
 *
 * A fork of the naive-compaction conductor that applies a RECENCY-GRADED COMPRESSION
 * GRADIENT across the aged region instead of one uniform treatment. The aged region —
 * everything older than the protected working tail, not human-held, not already grouped —
 * is split at its TOKEN MIDPOINT into two halves that get different treatment:
 *
 *     ┌──────────── protected working tail ────────────┐  raw, untouched (host floor)
 *     │  newest reasoning, never folded                 │
 *     ├──────────── newer half of aged region ─────────┤  Bear-2 `replace` (lite, legible)
 *     │  aged but recent: extractively shaved, readable │
 *     ├──────────── older half of aged region ─────────┤  LLM summary `group` (naive compaction)
 *     │  oldest: collapsed to one prose summary (lossy) │
 *     └─────────────────────────────────────────────────┘
 *
 * The OLDER half is naive compaction, VERBATIM: the same `COMPACTION_SYSTEM` prompt, the
 * same recursive/amnesiac `buildPrompt` merge, the same single-inflight + `lastAttemptKey`
 * guard, the same `compactedIds` monotonic cover, emitted as `group` command(s). The only
 * change is SCOPE — `compactedIds` is restricted to the older half so the summary group can
 * never span a newer-half block that is simultaneously being `replace`d (that would be a
 * command conflict).
 *
 * The NEWER half is the genuinely new machinery: per-block Bear-2 `replace`. Bear-2 (The
 * Token Company) is an extractive, DETERMINISTIC token-deletion model — same input → the same
 * shorter prose, which the agent reads directly (no `{#code FOLDED}` tag, no `unfold`). Because
 * it is deterministic, a compressed result is valid forever: each eligible block is compressed
 * AT MOST ONCE and the result cached by block id. Recovery is by human DETACH only (same model
 * as naive compaction).
 *
 * VISIBLE-TOKENS ACCOUNTING (critical — extends naive compaction's). `view.liveTokens` is the
 * RAW, fully-unfolded size (the host clears conductor folds every pass), so a naive
 * `liveTokens >= 90%` test would re-fire every pass once first crossed. We must subtract BOTH
 * savings sources:
 *     visible       = liveTokens − summarySaving − bear2Saving
 *     summarySaving = Σ(original tokens of summarized older-half blocks) − summaryTokenCost
 *     bear2Saving   = Σ over CURRENT newer-half blocks with a SHRINKING cached compressed value of
 *                       (tokenLen(originalTrimmed) − tokenLen(compressed))   [the bear2Delta gate]
 * The shrink decision and the saving measure go through ONE helper (`bear2Delta`) on ONE unit
 * (trimmed-text tokens), so a block credited in this math is exactly a block `emitState` emits a
 * `replace` for — no two-unit drift (FIX 3).
 * Both treatments shrink `visible`; the single 90% trigger fires both and waits for the window
 * to refill before acting again (the sliding-window / naive-compaction high-water band).
 *
 * FAILURE STATE MACHINE (ADR 0015). A Bear-2 failure is a FULL conductor failure — never a
 * silent degrade (this conductor's whole identity is Bear-2; degrading silently would violate
 * Accordion's source-of-truth principle):
 *   - NO KEY / capability unavailable → idle, actionable prompt, return [] (clear to raw). This
 *     is "not configured", NOT the FAILED alarm; the older-half compaction does NOT run either.
 *   - TRANSIENT failure → one retry: per-block retry counter; while count < 2 the block stays
 *     uncached and is retried on a later pass. NOTE: that retry fires on the very next pass
 *     (microtask) — it only guards an INSTANTANEOUS blip. Any sustained failure (network / 429 /
 *     5xx lasting longer than a tick) exhausts the retry and trips the hard freeze below. By
 *     design (freeze hard, alert loud) — there is deliberately no backoff.
 *   - HARD failure → when a block's retry count reaches 2 (failed twice), set sticky `failed`.
 *     Once failed: freeze hard — loud persistent status, return null (hold last applied state,
 *     emit nothing new). Stays failed until detach/re-attach.
 *   - LLM summary `complete` failure → inherit naive compaction's handling (hold prior state,
 *     don't hammer). It does NOT trip the Bear-2 `failed` flag — that flag is Bear-2's alone.
 *
 * Locks `["human-steering", "agent-unfold"]` — identical to naive compaction. `human-steering`
 * is load-bearing twice over: it keeps the older-half region contiguous (so the one summary
 * `group` is a valid run) AND stops the human fighting the per-block `replace` on the newer
 * half. `agent-unfold` is the honest declaration of intent (neither half carries fold tags).
 * `tail-size` stays collaborative — locking it would erase the protected tail and let the
 * conductor compress the live working tail.
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
// The older half is naive compaction VERBATIM (ADR 0015) — so the system prompt and the
// pure block helpers are SHARED from the naive-compaction conductor, not copied. (`buildPrompt`
// is a method tied to instance state, so it stays local.)
import { COMPACTION_SYSTEM, blockLabel, sumTokens } from "../compaction-naive/compaction-naive";

/** Fraction of budget at which both treatments trigger (high-water mark). */
const TRIGGER = 0.9;

/** Minimum block size (tokens) for a newer-half block to be worth a Bear-2 call. */
const BEAR2_MIN_TOKENS = 400;

/** Max simultaneous in-flight Bear-2 compress calls. */
const BEAR2_CONCURRENCY = 8;

/** A block must fail Bear-2 this many times before the conductor freezes hard. */
const BEAR2_MAX_RETRIES = 2;

/**
 * Soft cap on summary output tokens. Sized as in naive compaction: this conductor compacts
 * roughly 10k–100k tokens of older-half history at a time, so the briefing needs room. The
 * host clamps the requested max to the model's own ceiling before sending, and the model
 * enforces it as a hard generation cap, so requesting more than a model allows is safe.
 */
const MAX_SUMMARY_TOKENS = 8000;

export class Bear2HybridConductor implements Conductor {
	readonly id = "bear2-hybrid";
	readonly label = "Bear-2 hybrid";

	/**
	 * Involvement locks (ADR 0011) — identical to naive compaction. `human-steering` is
	 * load-bearing TWICE: it keeps the older half contiguous (the one summary `group` stays a
	 * valid run) and it stops the human fighting the per-block `replace` on the newer half.
	 * `agent-unfold` is the honest declaration of intent — neither half carries a `{#code FOLDED}`
	 * tag, so the agent has nothing to unfold. NOT `tail-size`: under that lock the host sets
	 * `protectedFromIndex = blocks.length`, erasing the protected tail and letting the conductor
	 * compress the agent's live working tail — which mainstream compaction never does.
	 */
	readonly locks = ["human-steering", "agent-unfold"] as const;

	// ── instance state ─────────────────────────────────────────────────────────

	/** Injected by attach(); null until the conductor is attached. */
	private host: ConductorHost | null = null;

	// ── older-half (LLM summary) state — forked from naive compaction ───────────

	/** The current compaction summary text (with its count preamble). Null until the first summary completes. */
	private summary: string | null = null;

	/**
	 * The block ids currently represented by the summary — the monotonic "already summarized"
	 * set. SCOPED TO THE OLDER HALF ONLY (ADR 0015): never includes a newer-half block, so the
	 * summary group can never overlap a `replace`d block. Grows only within a session; cleared
	 * on attach. Empty until the first summary completes.
	 */
	private compactedIds: Set<string> = new Set();

	/** AbortController for the in-flight summary completion, or null when idle. */
	private inflight: AbortController | null = null;

	/**
	 * Stable key of the NEWLY-OLDER block set we most recently ATTEMPTED to summarize. Prevents
	 * re-launching the exact same set after a rejected/failed completion. Keyed on the newly-older
	 * ids only (NOT the full older set) so a pure SHRINK of the older set does not re-launch.
	 * Set when a completion launches; cleared implicitly on success (the set joins compactedIds).
	 */
	private lastAttemptKey: string = "";

	// ── newer-half (Bear-2) state ───────────────────────────────────────────────

	/**
	 * Cache of Bear-2 output by block id. Bear-2 is deterministic, so a cached result is valid
	 * FOREVER — each block is compressed at most once. Persists across the newer→older migration
	 * harmlessly (a block that ages into the older half just stops being read here). Cleared on
	 * attach.
	 */
	private bear2Cache: Map<string, string> = new Map();

	/** Ids of blocks with a Bear-2 compress call currently in flight. Bounds concurrency. */
	private bear2InFlight: Set<string> = new Set();

	/**
	 * Per-block Bear-2 retry counter. Incremented on each compress rejection; a block stays
	 * uncached (and is retried on a later pass) while its count is < BEAR2_MAX_RETRIES. Reaching
	 * BEAR2_MAX_RETRIES trips the sticky `failed` flag (freeze hard).
	 */
	private bear2Retries: Map<string, number> = new Map();

	/**
	 * Sticky HARD-failure flag. Set when any block exhausts its Bear-2 retries. Once set the
	 * conductor freezes: it returns null (hold last applied state) and emits nothing new. Cleared
	 * only by attach() (i.e. detach + re-attach).
	 */
	private failed: boolean = false;

	// ── lifecycle ──────────────────────────────────────────────────────────────

	attach(host: ConductorHost): void {
		// A conductor lifetime starts FRESH on attach (the contract allows re-attaching the same
		// instance; nothing from a prior session may leak in). Reset ALL instance state.
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.summary = null;
		this.compactedIds = new Set();
		this.lastAttemptKey = "";
		this.bear2Cache = new Map();
		this.bear2InFlight = new Set();
		this.bear2Retries = new Map();
		this.failed = false;
		this.host = host;
	}

	detach(): void {
		// Cancel the in-flight summary completion so a stale result can't call requestRerun()
		// after the conductor is gone. Bear-2 compress calls have no AbortController (the host
		// surface takes no signal); their resolve handlers self-guard on `this.host` instead.
		if (this.inflight) {
			this.inflight.abort();
			this.inflight = null;
		}
		this.host?.setStatus(null);
		this.host = null;
	}

	// ── main conduct loop ───────────────────────────────────────────────────────

	conduct(view: ConductorView): Command[] | null {
		// Cannot operate without a host (e.g. headless test without attach).
		if (!this.host) return null;

		// HARD-FAILED: freeze. Hold whatever was last applied, emit nothing new. The loud status
		// is re-asserted so it stays visible. Only attach() clears `failed`.
		if (this.failed) {
			this.host.setStatus("⛔ Bear-2 FAILED — conductor halted");
			return null;
		}

		// NOT CONFIGURED: no Bear-2 capability ⇒ this conductor cannot do its job. Go idle with an
		// actionable prompt and clear to raw. We do NOT run the older-half compaction either — a
		// Bear-2 conductor with no Bear-2 is not configured, not a half-working fallback. This is
		// distinct from the FAILED alarm (which is for a configured key that then broke).
		if (!this.host.can("compress")) {
			this.host.setStatus("Bear-2 needs an API key — set it in Settings");
			return [];
		}

		// Degenerate config / empty session: nothing to manage. Hold any existing state. Clear any
		// stale "Bear-2: …" metrics status first so the status bar doesn't keep showing the last
		// session's numbers after the view empties out.
		if (view.budget <= 0 || view.blocks.length === 0) {
			this.host.setStatus(null);
			return this.emitState(view);
		}

		// PRUNE STALE Bear-2 bookkeeping. bear2Cache / bear2Retries are otherwise only cleared when
		// a block enters compactedIds — so an id that vanishes from view.blocks by ANY other path
		// (resync, truncation, the human discarding history) would leak forever. Drop every entry
		// whose id is no longer present in the live view.
		const liveIds = new Set(view.blocks.map((b) => b.id));
		for (const id of this.bear2Cache.keys()) if (!liveIds.has(id)) this.bear2Cache.delete(id);
		for (const id of this.bear2Retries.keys()) if (!liveIds.has(id)) this.bear2Retries.delete(id);

		// AGED REGION: every block older than the protected working tail, not human-held, not
		// already inside a (non-conductor) group. Index-ordered oldest→newest.
		const aged = this.agedRegion(view);

		// SPLIT at the token midpoint. Older half = up to 50% of aged tokens (walking
		// oldest→newest); newer half = the rest. Returns id-sets so membership is recomputed by
		// index every pass — blocks migrate newer→older naturally as the line marches forward.
		const { olderIds, newerHalf } = this.splitAged(aged);

		// ── VISIBLE accounting ──────────────────────────────────────────────────
		// Both savings sources subtracted from the raw baseline, or the 90% trigger re-fires
		// every pass (liveTokens only grows; the host clears conductor folds each pass).
		const summarySaving = this.summarySaving(aged);
		const bear2Saving = this.bear2Saving(newerHalf);
		const visible = view.liveTokens - summarySaving - bear2Saving;
		const overThreshold = visible >= view.budget * TRIGGER;

		// ── NEWER HALF: launch Bear-2 compress for eligible, uncached, not-in-flight blocks ──
		// Only when over threshold (the single trigger). Below it we still EMIT existing replaces
		// (incremental / cache-warm), we just don't launch new compression.
		if (overThreshold) {
			this.launchBear2(newerHalf);
		}

		// ── OLDER HALF: drive the LLM summary exactly as naive compaction does, but scoped to
		// the older half. compactedIds only ever contains older-half ids, so the summary group
		// never overlaps a newer-half replace.
		this.driveSummary(view, olderIds, overThreshold);

		// METRICS while operating normally (only when something is actually happening — keep the
		// status quiet on a calm session, like naive compaction clears to null below threshold).
		this.reportMetrics(newerHalf, aged, overThreshold);

		// EMIT the complete desired state: one `replace` per cached newer-half block + the
		// summary `group`(s) over the compacted older-half survivors. Never both for one block —
		// the two sets are disjoint by construction (split point + older-only compactedIds).
		return this.emitState(view, newerHalf);
	}

	// ── region + split ────────────────────────────────────────────────────────

	/**
	 * The aged region: every block older than the protected working tail that is not human-held
	 * and not already inside a group. All kinds included (eligibility filtering for Bear-2
	 * happens later; the summary group swallows whatever the host can fold).
	 */
	private agedRegion(view: ConductorView): ViewBlock[] {
		const aged: ViewBlock[] = [];
		const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
		for (let i = 0; i < pfi; i++) {
			const b = view.blocks[i];
			if (!b.held && !b.grouped) aged.push(b);
		}
		return aged;
	}

	/**
	 * Split the aged region at its TOKEN MIDPOINT, not its block-count midpoint (blocks vary
	 * 30→5000 tokens, so a count split lopsides the token mass). Walk oldest→newest summing
	 * `tokens`: a block joins the OLDER half as long as the running older-half total stays at or
	 * below 50% of total aged tokens; everything after the line is the NEWER half.
	 *
	 * Returns the older half as an id SET (membership test for compactedIds scoping) and the
	 * newer half as the ViewBlock list (we need tokens/text/kind for Bear-2). Recomputed every
	 * pass, so a block migrates newer→older the instant the midpoint marches past it.
	 *
	 * `compactedIds` is AUTHORITATIVE (ADR 0015 / fix): any block already represented by the
	 * summary is forced into the older half and excluded from `newerHalf`, regardless of where
	 * the token midpoint falls. This keeps the two treatments disjoint even when the human GROWS
	 * the protected tail after a summary committed (which can pull the midpoint back into the
	 * already-compacted range) — without it, such a block would receive BOTH a `replace` and the
	 * `group`, and be double-counted in `bear2Saving`.
	 */
	private splitAged(aged: ViewBlock[]): { olderIds: Set<string>; newerHalf: ViewBlock[] } {
		const total = sumTokens(aged);
		const half = total / 2;
		const olderIds = new Set<string>();
		const newerHalf: ViewBlock[] = [];
		let running = 0;
		for (const b of aged) {
			// Already summarized → belongs to the older half no matter what the midpoint says.
			// Never a Bear-2 candidate (the summary group owns it).
			if (this.compactedIds.has(b.id)) {
				olderIds.add(b.id);
				running += b.tokens;
				continue;
			}
			// Keep adding to the older half while we're at or below the midpoint. The "<= half
			// BEFORE adding" test means the block that crosses the line lands in the older half
			// when the running total is still under half, and in the newer half once we're at/over
			// it — a stable, monotonic boundary as tokens accrue.
			if (running < half) {
				olderIds.add(b.id);
				running += b.tokens;
			} else {
				newerHalf.push(b);
			}
		}
		return { olderIds, newerHalf };
	}

	/** Is a block eligible for Bear-2? Foldable prose kind, big enough to be worth a call. */
	private bear2Eligible(b: ViewBlock): boolean {
		if (b.tokens < BEAR2_MIN_TOKENS) return false;
		return b.kind === "text" || b.kind === "thinking" || b.kind === "tool_result";
	}

	// ── VISIBLE accounting ──────────────────────────────────────────────────────

	/**
	 * The summary saving: Σ(original tokens of summarized older-half blocks still aged) minus the
	 * summary's own token cost. Identical in spirit to naive compaction's `savedTokens`, but the
	 * survivors are intersected with the aged region (a compacted block that slid into the
	 * protected tail no longer counts as saved). Zero until the first summary completes.
	 */
	private summarySaving(aged: ViewBlock[]): number {
		if (this.summary === null) return 0;
		let survivors = 0;
		for (const b of aged) if (this.compactedIds.has(b.id)) survivors += b.tokens;
		return Math.max(0, survivors - this.summaryTokenCost());
	}

	/**
	 * THE SINGLE BEAR-2 SHRINK GATE (FIX 3 — one consistent basis). Given a block's ORIGINAL
	 * trimmed text and a candidate compressed string, returns the TOKEN saving
	 * `tokenLen(originalTrimmed) − tokenLen(compressed)`. Positive ⇒ Bear-2 genuinely shrank the
	 * block; ≤ 0 ⇒ no useful compression (and an empty result is treated as 0, never a saving).
	 *
	 * EVERY site that asks "did this block shrink, and by how much?" routes through here — the
	 * cache-store decision in `launchBear2`, the `replace` gate in `emitState`, `bear2Saving`, and
	 * `reportMetrics`. Previously the gate/emit used CHARACTER length on the trimmed text while
	 * `bear2Saving` used TOKENS against the untrimmed `b.tokens`; that two-unit drift could credit a
	 * block in the trigger math that `emitState` then refused to `replace` (or vice-versa). One
	 * helper, one unit (trimmed-text tokens), so they can never diverge again.
	 */
	private bear2Delta(originalTrimmed: string, compressed: string): number {
		if (compressed.length === 0) return 0;
		return this.tokenLen(originalTrimmed) - this.tokenLen(compressed);
	}

	/**
	 * The Bear-2 saving: Σ over CURRENT newer-half blocks that have a cached compressed value of
	 * `bear2Delta(originalTrimmed, compressed)` — the SAME shrink gate `emitState` uses to decide
	 * whether to emit a `replace`, on the SAME unit (FIX 3). Only current newer-half membership
	 * counts — a block that aged into the older half is summarized instead, so its Bear-2 saving
	 * must not be double-counted against the summary saving.
	 */
	private bear2Saving(newerHalf: ViewBlock[]): number {
		let saved = 0;
		for (const b of newerHalf) {
			const compressed = this.bear2Cache.get(b.id);
			if (compressed === undefined) continue;
			const delta = this.bear2Delta((b.text ?? "").trim(), compressed);
			if (delta > 0) saved += delta;
		}
		return saved;
	}

	/** Token cost of `text` via the host tokenizer when available, else a length/4 estimate. */
	private tokenLen(text: string): number {
		if (this.host && this.host.can("countTokens")) return this.host.countTokens(text);
		return Math.ceil(text.length / 4);
	}

	/** Token cost of the current summary (or 0 if none). */
	private summaryTokenCost(): number {
		if (this.summary === null) return 0;
		return this.tokenLen(this.summary);
	}

	// ── NEWER HALF: Bear-2 compression ──────────────────────────────────────────

	/**
	 * Fire-and-forget Bear-2 compression for eligible newer-half blocks that have no cache entry
	 * and aren't already in flight, respecting the concurrency cap. Each resolve caches the result
	 * and calls requestRerun(); each reject increments the retry counter (one retry) and, at the
	 * cap, trips the sticky `failed` flag.
	 *
	 * conduct() stays synchronous: this only KICKS OFF promises; nothing is awaited here.
	 */
	private launchBear2(newerHalf: ViewBlock[]): void {
		const host = this.host;
		// `conduct()` already returned [] when !can("compress"); can("compress") is true only when
		// the concrete `compress` method exists, so no redundant method-presence check here.
		if (!host) return;

		for (const b of newerHalf) {
			if (this.bear2InFlight.size >= BEAR2_CONCURRENCY) break;
			if (!this.bear2Eligible(b)) continue;
			if (this.bear2Cache.has(b.id)) continue;
			if (this.bear2InFlight.has(b.id)) continue;

			const text = (b.text ?? "").trim();
			if (!text) continue; // nothing to compress

			const id = b.id;
			this.bear2InFlight.add(id);

			// `compress` is present whenever `can("compress")` is true (verified in conduct()).
			host.compress!(text).then(
				(compressed) => {
					// STALE guard: if the conductor was detached/re-attached (host swapped),
					// `this.bear2InFlight` is a NEW set owned by the new session — do NOT mutate it.
					// Return without touching any instance state (mirrors launchCompletion's guard).
					if (this.host !== host) return;
					// Same session but hard-failed since launch: drop the result, but DO clear our
					// own in-flight slot (it's still our set) so concurrency accounting stays honest.
					if (this.failed) {
						this.bear2InFlight.delete(id);
						return;
					}
					this.bear2InFlight.delete(id);
					// Bear-2 is deterministic ⇒ cache forever; the block is never compressed again.
					// Guard against a degenerate empty/expanded result via the SINGLE shrink gate
					// (FIX 3 — same predicate/unit as emitState and bear2Saving): only cache the
					// compressed value if it genuinely shrinks the block (token delta > 0).
					const out = compressed ?? "";
					if (this.bear2Delta(text, out) > 0) {
						this.bear2Cache.set(id, out);
					} else {
						// No useful compression (e.g. structured content Bear-2 no-ops on). Cache the
						// ORIGINAL so we never re-call for this block; bear2Delta(text, text) === 0 so
						// bear2Saving contributes nothing and emitState skips the replace (no shrink).
						this.bear2Cache.set(id, text);
					}
					this.bear2Retries.delete(id);
					// Use the captured `host` (proven current by the guard above; non-null) rather
					// than `this.host` so TS keeps the non-null narrowing.
					host.requestRerun();
				},
				(_err) => {
					// STALE guard: host swapped (detach+re-attach) → `bear2InFlight`/retry maps are
					// the NEW session's; do NOT mutate them. Return without touching instance state.
					if (this.host !== host) return;
					// Same session but already hard-failed: drop, but clear our own in-flight slot.
					if (this.failed) {
						this.bear2InFlight.delete(id);
						return;
					}
					this.bear2InFlight.delete(id);
					const next = (this.bear2Retries.get(id) ?? 0) + 1;
					this.bear2Retries.set(id, next);
					if (next >= BEAR2_MAX_RETRIES) {
						// HARD failure: this block failed twice. Freeze the whole conductor.
						this.failed = true;
						host.setStatus("⛔ Bear-2 FAILED — conductor halted");
					}
					// Else: TRANSIENT. Leave the block uncached so a later pass retries it once.
					host.requestRerun();
				},
			);
		}
	}

	// ── OLDER HALF: LLM summary (forked from naive compaction, scoped to the older half) ──

	/**
	 * Drive the LLM summary over the OLDER HALF only. Mirrors naive compaction's conduct() body:
	 * compute newly-older blocks (older-half ids not yet in compactedIds), and when the visible
	 * window is over threshold AND there are newly-older blocks AND nothing is in flight AND the
	 * attempt key is new AND the host can complete, launch a completion. Otherwise hold.
	 *
	 * Pure orchestration: it mutates only summary/compactedIds/inflight/lastAttemptKey via the
	 * launch + resolve handlers. The actual `group` emission is in emitState/emitSummaryGroup.
	 */
	private driveSummary(view: ConductorView, olderIds: Set<string>, overThreshold: boolean): void {
		const host = this.host;
		if (!host) return;

		// A summary completion already in flight → never launch a second.
		if (this.inflight !== null) return;

		// Blocks in the older half not yet represented by the summary.
		const newlyOlder = view.blocks.filter((b) => olderIds.has(b.id) && !this.compactedIds.has(b.id));

		// Trigger only when over the high-water mark AND there is genuinely new older content.
		if (!overThreshold || newlyOlder.length === 0) return;

		// The older half needs an LLM to summarize. If the host can't complete, naive compaction
		// holds prior state (no deterministic fallback). Same here: we simply don't launch; the
		// Bear-2 half still works on its own transport.
		if (!host.can("complete")) return;

		// Gate the launch on a stable signature of the NEWLY-OLDER set (not the full older set):
		// prevents re-launching the same set after a rejection, and re-launching on a pure shrink.
		const attemptKey = newlyOlder.map((b) => b.id).sort().join("\0");
		if (attemptKey === this.lastAttemptKey) return;

		// The full older-half set (for the count preamble + compactedIds snapshot) is every
		// older-half block currently present, in order.
		const olderBlocks = view.blocks.filter((b) => olderIds.has(b.id));
		this.launchCompletion(olderBlocks, newlyOlder, attemptKey);
	}

	/**
	 * Fire-and-forget LLM completion to (re)build the older-half summary. Snapshots ids at launch
	 * so the resolve handler commits against exactly the blocks it summarized. Forked from naive
	 * compaction; the only difference is the snapshotted ids are the older-half set.
	 */
	private launchCompletion(olderBlocks: ViewBlock[], newlyOlder: ViewBlock[], attemptKey: string): void {
		const host = this.host;
		if (!host) return;
		if (this.inflight !== null) return;

		const launchedOlderIds = new Set(olderBlocks.map((b) => b.id));
		const count = olderBlocks.length;
		const prompt = this.buildPrompt(newlyOlder);

		// Record the attempt key so a rejected completion does not immediately re-launch for the
		// same newly-older set on the next tick.
		this.lastAttemptKey = attemptKey;

		const controller = new AbortController();
		this.inflight = controller;

		host.complete({
			system: COMPACTION_SYSTEM,
			prompt,
			maxOutputTokens: MAX_SUMMARY_TOKENS,
			signal: controller.signal,
		}).then(
			(result) => {
				// Stale-completion guard: if detached/re-attached (new controller) while this
				// promise was outstanding, this.inflight no longer points at OUR controller — bail
				// without touching state. Also bail if the conductor hard-failed in the meantime.
				if (this.inflight !== controller) return;
				if (this.failed) {
					this.inflight = null;
					return;
				}
				const text = result.text.trim();
				if (!text) {
					// Empty output: treat as a failed attempt — preserve prior summary/state and wait
					// for genuinely new older content before retrying this same key. This is an LLM
					// (summary) failure, NOT a Bear-2 failure, so it does NOT trip `failed`.
					this.inflight = null;
					this.host?.setStatus("Naive compaction failed — model returned an empty summary", {
						older: count,
					});
					return;
				}
				// Success: commit the new summary scoped to the older half.
				this.inflight = null;
				this.summary =
					`[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n` +
					text;
				this.compactedIds = launchedOlderIds;
				// Housekeeping: any block that just entered the summary is no longer a Bear-2
				// candidate, so drop its stale Bear-2 cache / retry bookkeeping. (`splitAged`'s
				// compactedIds exclusion is the load-bearing fix; this just keeps the maps tidy.)
				for (const id of launchedOlderIds) {
					this.bear2Cache.delete(id);
					this.bear2Retries.delete(id);
				}
				this.host?.requestRerun();
			},
			(_err) => {
				// Stale-completion guard.
				if (this.inflight !== controller) return;
				// Rejected (abort/network/unknown model). Clear inflight, leave prior summary
				// intact, do NOT relaunch immediately (the lastAttemptKey guard only retries when
				// genuinely new older content arrives). An LLM summary failure does NOT trip the
				// Bear-2 `failed` flag — that flag is Bear-2's alone (ADR 0015).
				this.inflight = null;
			},
		);
	}

	/**
	 * Build the user-role compaction prompt — forked VERBATIM from naive compaction. The format
	 * spec lives in COMPACTION_SYSTEM (identical both passes); this only varies the input wrapper
	 * and the one-line mode preamble. Recursive path feeds the prior summary + only newly-older
	 * blocks (recursive amnesia — originals already compressed are deliberately not re-read).
	 */
	private buildPrompt(newlyOlder: ViewBlock[]): string {
		const conversation = newlyOlder
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
				"Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move completed work into \"Progress\" and revise \"Next Steps\" accordingly. Preserve exact file paths, function names, and error messages when known. Carry forward every verbatim user message from the previous summary and append the new user messages from the conversation — all still reproduced word-for-word in \"## User messages\".",
			].join("\n");
		}

		return [
			"<conversation>",
			conversation,
			"</conversation>",
			"",
			"Create a structured summary from the conversation history above.",
		].join("\n");
	}

	// ── emission ─────────────────────────────────────────────────────────────────

	/**
	 * Emit the conductor's COMPLETE desired state:
	 *   - one `replace` per CURRENT newer-half block that has a (shrinking) cached Bear-2 value, and
	 *   - the summary `group`(s) over the compacted older-half survivors.
	 *
	 * The two command sets are DISJOINT by construction: a block is either in the newer half (gets
	 * a replace) or, once the midpoint marches past it, in the older half (gets summarized via
	 * compactedIds). `compactedIds` only ever holds older-half ids, and `newerHalf` is recomputed
	 * by index every pass — so no block ever receives both a replace and a group in one batch.
	 *
	 * Returns `[]` (clear to raw) when there is nothing to apply — never `null` here (null is
	 * reserved for the FAILED freeze in conduct()).
	 */
	private emitState(view: ConductorView, newerHalf?: ViewBlock[]): Command[] {
		const cmds: Command[] = [];

		// Newer-half replaces. Only for blocks CURRENTLY in the newer half with a cached value that
		// actually shrinks the text (a no-op cache entry — original stored — is skipped so we don't
		// emit a pointless self-replace the host would have to process).
		if (newerHalf) {
			for (const b of newerHalf) {
				const compressed = this.bear2Cache.get(b.id);
				if (compressed === undefined) continue;
				const original = (b.text ?? "").trim();
				// SINGLE shrink gate (FIX 3): emit a replace only when Bear-2 genuinely shrank the
				// block — same predicate/unit as the cache-store decision and bear2Saving, so a
				// block credited in the trigger math is exactly a block we emit a replace for.
				if (this.bear2Delta(original, compressed) <= 0) continue;
				cmds.push({ kind: "replace", id: b.id, content: compressed });
			}
		}

		// Older-half summary group(s).
		for (const g of this.emitSummaryGroup(view)) cmds.push(g);

		return cmds;
	}

	/**
	 * Emit the summary as `group` command(s) (digest = summary) covering the compacted survivors.
	 * Forked from naive compaction. Re-derived from the LIVE view every pass: one group per
	 * MAXIMAL CONTIGUOUS run of survivors (blocks in compactedIds still in the aged prefix, not
	 * held / not grouped), walking the full aged prefix so a held/grouped block SPLITS the run
	 * rather than being spanned. Under `human-steering` the older half is contiguous ⇒ exactly one
	 * run ⇒ one summary tile.
	 *
	 * Returns [] when there are no survivors (clear to raw — lossless; the host resets blocks to
	 * full content this pass). Never returns null (this conductor's null is reserved for the
	 * FAILED freeze).
	 */
	private emitSummaryGroup(view: ConductorView): Command[] {
		if (this.summary === null) return [];

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

	// ── metrics ──────────────────────────────────────────────────────────────────

	/**
	 * Surface the live savings split so the PoC's headroom question is answerable at a glance:
	 *   Bear-2: {n} blocks · {k} saved ({pct}%)  |  Summary: {m} blocks · {s} saved
	 * Computed from the Bear-2 cache (bear2Saving) and the summary (summarySaving). Kept quiet
	 * (status cleared) when nothing is happening — calm session, no over-threshold pressure and
	 * no applied state.
	 */
	private reportMetrics(newerHalf: ViewBlock[], aged: ViewBlock[], overThreshold: boolean): void {
		const host = this.host;
		if (!host) return;

		// Bear-2 side: blocks with a shrinking cache entry, and their total saving.
		let bearBlocks = 0;
		let bearOriginal = 0;
		let bearSaved = 0;
		for (const b of newerHalf) {
			const compressed = this.bear2Cache.get(b.id);
			if (compressed === undefined) continue;
			// SINGLE shrink gate (FIX 3): the displayed metric uses the same delta as bear2Saving.
			const delta = this.bear2Delta((b.text ?? "").trim(), compressed);
			if (delta <= 0) continue; // no-op compression (e.g. structured content) — not a "saved" block
			bearBlocks += 1;
			bearOriginal += b.tokens;
			bearSaved += delta;
		}

		// Summary side: compacted older-half survivors still in the aged region.
		let summaryBlocks = 0;
		for (const b of aged) if (this.compactedIds.has(b.id)) summaryBlocks += 1;
		const summarySaved = this.summarySaving(aged);

		// Nothing applied and not under pressure → keep the status bar quiet.
		if (bearBlocks === 0 && summaryBlocks === 0 && !overThreshold) {
			host.setStatus(null);
			return;
		}

		const pct = bearOriginal > 0 ? Math.round((bearSaved / bearOriginal) * 100) : 0;
		const text =
			`Bear-2: ${bearBlocks} block${bearBlocks === 1 ? "" : "s"} · ${fmtK(bearSaved)} saved (${pct}%)` +
			`  |  Summary: ${summaryBlocks} block${summaryBlocks === 1 ? "" : "s"} · ${fmtK(summarySaved)} saved`;

		host.setStatus(text, {
			bear2Blocks: bearBlocks,
			bear2Saved: bearSaved,
			summaryBlocks,
			summarySaved,
		});
	}
}

// ── utilities ─────────────────────────────────────────────────────────────────

/** Compact a token count for the status line (e.g. 8400 → "8.4k"). */
function fmtK(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

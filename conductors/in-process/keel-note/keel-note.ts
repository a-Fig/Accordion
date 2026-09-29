/*
 * keel-note.ts — keel-lite's synchronous budget keeper plus a small, model-written progress note
 * that survives every trim.
 *
 * WHY. keel-lite held its budget in every run of the 2026-09-28 SlopCode bench (0% of turns over),
 * but in one seed the agent stalled: once its oldest turns were folded it lost continuity and
 * started talking about "the previous agent (me)". compaction-naive kept continuity (its summary
 * is the agent's memory) but was over budget on 12–17% of turns, because an async summary lags a
 * step that adds ~15k tokens. keel-note keeps the part that must be synchronous (the trim) exactly
 * as keel-lite does it, and moves the memory into a small note that is refreshed OFF the hot path.
 *
 *   1. COMPOSITION. keel-note wraps an unmodified `KeelLiteConductor`, attached to a thin proxy of
 *      the real host. The proxy changes exactly three things:
 *        - `stats().liveTokens` (and the `liveTokens` carried by events) is reported as
 *          `real + reserve`, where `reserve = max(0, noteMaxTokens − carrierCost)`. keel-lite
 *          therefore plans against a context that already contains a full-size note, from the
 *          first turn on, whether or not a note exists yet. Landing a note (cost ≤ noteMaxTokens)
 *          never changes `real + reserve`, so a late landing can never push the context over
 *          what keel-lite already made room for.
 *        - the CARRIER block (below) is reported `held`, so keel-lite never folds, trims or groups
 *          it and never adopts it on a resync.
 *        - `propose` records which blocks each of keel-lite's applied epochs dropped (folded,
 *          replaced or grouped), copying their original text at trim time as the next note input.
 *      Budget enforcement is keel-lite's, unchanged and synchronous: nothing here ever waits on a
 *      model call before trimming.
 *   2. THE NOTE rides on one existing block, because a conductor cannot insert blocks: the first
 *      assistant `text`/`thinking` block after the first user message (the task) that has left
 *      the protected tail. A note lands as a non-recoverable `replace` of that block, verbatim (no
 *      `{#code FOLDED}` handle), capped at `noteMaxTokens` including block overhead. Before the
 *      first note exists the carrier keeps its original content (in SlopCode, a one-line thought).
 *   3. REFRESH TRIGGERS. (a) An applied keel-lite epoch that dropped content the note has not yet
 *      seen. (b) A fallback after `fallbackTurns` turns with no trigger, fed the most recent
 *      not-yet-seen blocks. While an update is in flight, new spans accumulate (coalescing) and a
 *      follow-up call is chained when it lands. The pending buffer keeps only the most recent
 *      `spanMaxTokens` tokens; each block is clipped head+tail and sent to the note model once.
 *   4. THE UPDATE CALL goes through `host.complete` (the live session's model and route, logged by
 *      the extension's completion-usage log). Its input is the previous note plus the dropped
 *      span(s), framed as the agent's OWN earlier turns; the output is five terse first-person
 *      sections under a fixed header.
 *   5. ASYNC LANDING. A finished note waits in `ready` and lands at the next `turn-committed`,
 *      before keel-lite evaluates that turn, or right after an applied keel-lite epoch, whichever
 *      comes first. The old note stays until then. A failed or timed-out call keeps the old note,
 *      puts its spans back in the buffer, and is retried on the next trigger. The agent loop never
 *      waits for a note. Rewriting the carrier (an early block) invalidates the provider's prompt
 *      cache from that point on, as an epoch does; `landDelayTurns > 0` lets a finished note wait
 *      up to that many turn boundaries for the next epoch so both cache busts coincide, and
 *      `minLandGapTurns > 0` spaces fresh landings at least that many turns apart (updates keep
 *      running and fold into the waiting note). Both default to 0, i.e. land at the next boundary.
 */
import type { Conductor, ConductorHost, HostEvent, ViewBlock, CompletionRequest } from "../../../core/conductor/contract";
import type { Op, TxnResult } from "../../../core/ops";
import { messageKey } from "../../../core/groupShape";
import { isDurableId } from "../../../core/wire";
import { BLOCK_OVERHEAD, estTokens } from "../../../core/tokens";
import { KeelLiteConductor, type KeelLiteOptions } from "../keel-lite/keel-lite";

// ── knobs ─────────────────────────────────────────────────────────────────────────────────

export interface KeelNoteOptions {
	/** keel-lite's own knobs (HIGH/LOW band, ladder thresholds). */
	keel?: KeelLiteOptions;
	/** Hard cap on the landed note, block overhead included (calibrated tokens). Default 600. */
	noteMaxTokens?: number;
	/** Refresh after this many turns with no trim-triggered refresh. Default 30. */
	fallbackTurns?: number;
	/** The pending span buffer keeps only the most recent this-many tokens. Default 12000. */
	spanMaxTokens?: number;
	/** Each captured block is clipped (head + tail) to about this many tokens. Default 1500. */
	blockMaxTokens?: number;
	/** A trim starts a call only once at least this many span tokens are pending. Default 400. */
	minSpanTokens?: number;
	/** Abandon a note call after this long (ms); the old note stays. Default 90000. */
	timeoutMs?: number;
	/**
	 * A finished note may wait up to this many turn boundaries for a keel-lite epoch to land with
	 * (one prompt-cache bust instead of two). 0 = land at the next boundary. Default 0.
	 */
	landDelayTurns?: number;
	/**
	 * A fresh note never lands within this many turns of the previous landing (the first note is
	 * exempt). Updates keep running meanwhile; the newest one lands. 0 = no spacing. Default 0.
	 */
	minLandGapTurns?: number;
}

export const KEEL_NOTE_DEFAULTS: Readonly<Required<Omit<KeelNoteOptions, "keel">>> = Object.freeze({
	noteMaxTokens: 600,
	fallbackTurns: 30,
	spanMaxTokens: 12_000,
	blockMaxTokens: 1_500,
	minSpanTokens: 400,
	timeoutMs: 90_000,
	landDelayTurns: 0,
	minLandGapTurns: 0,
});

/** The fixed first line of every landed note. */
export const NOTE_HEADER = "My progress notes (written by me, earlier in this same session; older turns were trimmed from my context):";

/** The five sections, in order. The model writes them; `fitNote` trims them to the cap. */
export const NOTE_SECTIONS = ["Current goal / checkpoint", "Built & verified", "Tried and failed", "Current failing test / error", "Next step"] as const;

/** A tool call is context for its result; its args (a whole file for `write`) rarely matter. */
const CALL_MAX_TOKENS = 300;

// ── internal shapes ───────────────────────────────────────────────────────────────────────

export interface SpanEntry {
	id: string;
	order: number;
	text: string;
	tokens: number;
}

type Listener = (e: HostEvent) => void | Promise<void>;

// ── the conductor ─────────────────────────────────────────────────────────────────────────

export class KeelNoteConductor implements Conductor {
	readonly id = "keel-note";
	readonly label = "Keel-note";
	readonly description =
		"keel-lite's synchronous budget keeper plus a small first-person progress note, pinned after the task and refreshed off the hot path by a model call whenever a trim drops old turns. The trim never waits for the note.";

	private readonly k: Readonly<Required<Omit<KeelNoteOptions, "keel">>>;
	private readonly keel: KeelLiteConductor;
	private host: ConductorHost | null = null;
	private off: (() => void) | null = null;
	/** keel-lite's subscription on the proxy. */
	private inner: Listener | null = null;

	/** The block the note rides on. */
	private carrierId: string | null = null;
	/** The note body (sections only) currently on the carrier, and the exact content landed. */
	private currentBody: string | null = null;
	private landedContent: string | null = null;
	/** A finished note waiting for the next turn boundary. */
	private ready: string | null = null;
	/** Turn boundaries `ready` has waited through (for `landDelayTurns`). */
	private readyTurns = 0;
	/** Turn boundaries since the last fresh landing (∞ before the first). */
	private turnsSinceLanding = Number.POSITIVE_INFINITY;
	private landing = false;

	/** Block ids whose content the note model has already been given (or is being given). */
	private captured = new Set<string>();
	private buffer: SpanEntry[] = [];
	private inflight: Promise<void> | null = null;
	private abort: AbortController | null = null;
	/** Bumped on detach so a call that settles afterwards is ignored. */
	private gen = 0;
	private turnsSinceTrigger = 0;

	// metrics
	private trims = 0;
	private calls = 0;
	private failures = 0;
	private refreshes = 0;
	private reasserts = 0;
	private fallbacks = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private tokensEstimated = false;
	private discardedSpanTokens = 0;
	private lastError: string | null = null;
	private keelText: string | null = null;
	private keelMetrics: Record<string, number | string | boolean> = {};

	constructor(opts: KeelNoteOptions = {}) {
		const { keel, ...rest } = opts;
		const k = { ...KEEL_NOTE_DEFAULTS, ...stripUndefined(rest) };
		if (!(Number.isFinite(k.noteMaxTokens) && k.noteMaxTokens >= 64)) throw new RangeError(`keel-note: noteMaxTokens must be ≥ 64, got ${k.noteMaxTokens}`);
		if (!(Number.isInteger(k.fallbackTurns) && k.fallbackTurns >= 1)) throw new RangeError(`keel-note: fallbackTurns must be an integer ≥ 1, got ${k.fallbackTurns}`);
		if (!(k.spanMaxTokens >= 500)) throw new RangeError(`keel-note: spanMaxTokens must be ≥ 500, got ${k.spanMaxTokens}`);
		if (!(k.blockMaxTokens >= 50)) throw new RangeError(`keel-note: blockMaxTokens must be ≥ 50, got ${k.blockMaxTokens}`);
		if (!(k.minSpanTokens >= 0)) throw new RangeError(`keel-note: minSpanTokens must be ≥ 0`);
		if (!(k.timeoutMs > 0)) throw new RangeError(`keel-note: timeoutMs must be > 0`);
		if (!(Number.isInteger(k.landDelayTurns) && k.landDelayTurns >= 0)) throw new RangeError(`keel-note: landDelayTurns must be an integer ≥ 0, got ${k.landDelayTurns}`);
		if (!(Number.isInteger(k.minLandGapTurns) && k.minLandGapTurns >= 0)) throw new RangeError(`keel-note: minLandGapTurns must be an integer ≥ 0, got ${k.minLandGapTurns}`);
		this.k = Object.freeze(k);
		this.keel = new KeelLiteConductor(keel);
	}

	/** The effective note knobs. */
	get options(): Readonly<Required<Omit<KeelNoteOptions, "keel">>> {
		return this.k;
	}

	/** The wrapped keel-lite's effective knobs. */
	get keelOptions(): KeelLiteConductor["options"] {
		return this.keel.options;
	}

	attach(host: ConductorHost): void {
		this.host = host;
		this.gen++;
		this.pickCarrier(host);
		this.off = host.on((e) => this.onEvent(e));
		this.keel.attach(this.proxy(host));
	}

	detach(): void {
		this.gen++;
		this.abort?.abort(new Error("keel-note detached"));
		this.off?.();
		this.off = null;
		const host = this.host;
		this.host = null; // first, so keel-lite's own status clear below is not re-published
		this.keel.detach();
		host?.setStatus(null);
		this.inner = null;
		this.carrierId = null;
		this.currentBody = null;
		this.landedContent = null;
		this.ready = null;
		this.readyTurns = 0;
		this.turnsSinceLanding = Number.POSITIVE_INFINITY;
		this.landing = false;
		this.captured.clear();
		this.buffer = [];
		this.inflight = null;
		this.abort = null;
		this.turnsSinceTrigger = 0;
		this.keelText = null;
		this.keelMetrics = {};
	}

	/** Test/diagnostic view of the note state. */
	get noteState(): { carrierId: string | null; body: string | null; ready: boolean; inFlight: boolean; pendingSpanTokens: number } {
		return { carrierId: this.carrierId, body: this.currentBody, ready: this.ready !== null, inFlight: this.inflight !== null, pendingSpanTokens: sumTok(this.buffer) };
	}

	// ── the proxy keel-lite runs against ────────────────────────────────────────────────────

	private proxy(host: ConductorHost): ConductorHost {
		const mask = (b: ViewBlock | undefined): ViewBlock | undefined => (b && b.id === this.carrierId && !b.held ? { ...b, held: true } : b);
		return {
			on: (fn) => {
				this.inner = fn;
				return () => {
					if (this.inner === fn) this.inner = null;
				};
			},
			get: (id) => mask(host.get(id)),
			blocks: () => host.blocks().map((b) => mask(b)!),
			groups: () => host.groups(),
			textOf: (id) => host.textOf(id),
			stats: () => {
				const s = host.stats();
				return { ...s, liveTokens: s.liveTokens + this.reserve(host) };
			},
			systemPrompt: () => host.systemPrompt(),
			countTokens: (t) => host.countTokens(t),
			digestOf: (id) => host.digestOf(id),
			complete: (req) => host.complete(req),
			setStatus: (text, metrics) => {
				this.keelText = text;
				this.keelMetrics = text ? { ...(metrics ?? {}) } : {};
				if (text === null && this.host === null) return; // keel-lite's own detach
				this.publish();
			},
			propose: async (txn) => {
				const res = await host.propose(txn);
				if (this.host === host) this.onKeelApplied(host, res);
				return res;
			},
		};
	}

	/**
	 * Tokens the note may still add on top of what the carrier costs today. Without a usable
	 * carrier the whole cap is reserved.
	 */
	private reserve(host: ConductorHost): number {
		const b = this.carrierId ? host.get(this.carrierId) : undefined;
		const cost = b && !b.grouped ? (b.folded ? b.foldedTokens : b.tokens) : 0;
		return Math.max(0, this.k.noteMaxTokens - cost);
	}

	// ── events ─────────────────────────────────────────────────────────────────────────────

	private onEvent(e: HostEvent): void | Promise<void> {
		const host = this.host;
		if (!host) return;
		switch (e.type) {
			case "turn-committed": {
				this.turnsSinceTrigger++;
				if (this.ready !== null) this.readyTurns++;
				this.turnsSinceLanding++;
				if (this.turnsSinceTrigger >= this.k.fallbackTurns) this.fallback(host);
				this.ensureCarrier(host);
				const landed = this.land(host); // applies synchronously, before keel-lite plans
				return join(landed, this.forward(e));
			}
			case "blocks-appended":
				this.ensureCarrier(host);
				return this.forward({ ...e, liveTokens: e.liveTokens + this.reserve(host) });
			case "wire-departing":
				return this.forward({ ...e, liveTokens: e.liveTokens + this.reserve(host) });
			case "resync":
				this.ensureCarrier(host);
				return this.forward(e);
			case "state-changed":
				if (this.carrierId && e.changes.some((c) => c.id === this.carrierId && c.by !== "auto")) this.ensureCarrier(host);
				return this.forward(e);
			default:
				return this.forward(e);
		}
	}

	private forward(e: HostEvent): void | Promise<void> {
		return this.inner?.(e);
	}

	// ── carrier ────────────────────────────────────────────────────────────────────────────

	/** Keep the current carrier while it is usable; otherwise pick a new one. */
	private ensureCarrier(host: ConductorHost): string | null {
		if (this.carrierId) {
			const b = host.get(this.carrierId);
			if (b && usableCarrier(b)) return this.carrierId;
			this.carrierId = null; // held by a human, grouped, pulled into the tail, or gone
		}
		return this.pickCarrier(host);
	}

	/**
	 * The first assistant `text`/`thinking` block after the first user message that is outside the
	 * protected tail and usable. Within that first assistant message a `text` part is preferred
	 * (every provider replays it; some drop old reasoning).
	 */
	private pickCarrier(host: ConductorHost): string | null {
		const blocks = host.blocks();
		const firstUser = blocks.findIndex((b) => b.kind === "user");
		if (firstUser < 0) return null;
		for (let i = firstUser + 1; i < blocks.length; i++) {
			const b = blocks[i];
			if (b.protected) break;
			if (!usableCarrier(b)) continue;
			const key = messageKey(b.id);
			let pick = b;
			for (let j = i + 1; j < blocks.length && messageKey(blocks[j].id) === key; j++) {
				if (blocks[j].kind === "text" && usableCarrier(blocks[j])) {
					pick = blocks[j];
					break;
				}
			}
			this.carrierId = pick.id;
			return pick.id;
		}
		return null;
	}

	/**
	 * Does the carrier currently show the note we landed? Compared by cost, against both the
	 * calibrated and the raw estimate (a block not yet covered by a provider receipt is raw), so a
	 * calibration change alone never looks like a lost note (each re-assert re-bills the cache).
	 */
	private showsNote(host: ConductorHost, b: ViewBlock): boolean {
		if (!this.landedContent || !b.folded) return false;
		const near = (want: number) => Math.abs(b.foldedTokens - want) <= Math.max(3, 0.05 * want);
		return near(this.noteCost(host, this.landedContent)) || near(estTokens(this.landedContent) + BLOCK_OVERHEAD);
	}

	// ── landing ────────────────────────────────────────────────────────────────────────────

	/**
	 * At a turn boundary (or right after an epoch, `force`): land a finished note, or re-assert the
	 * current one if its carrier no longer shows it (the carrier moved, or a resync dropped the
	 * substitution). A finished note that is still inside `landDelayTurns` waits for an epoch unless
	 * forced, and none lands within `minLandGapTurns` of the previous one. The propose applies
	 * synchronously; only the result bookkeeping awaits.
	 */
	private land(host: ConductorHost, force = false): void | Promise<void> {
		if (this.landing) return;
		let fresh = this.ready !== null;
		if (fresh && this.turnsSinceLanding < this.k.minLandGapTurns) fresh = false; // too soon after the last one
		if (fresh && !force && this.readyTurns <= this.k.landDelayTurns) fresh = false; // hold it for an epoch
		const body = fresh ? this.ready : this.currentBody;
		if (body === null) return;
		const id = this.carrierId;
		const b = id ? host.get(id) : undefined;
		if (!id || !b) return; // no carrier yet: keep the note ready
		if (!fresh && this.showsNote(host, b)) return;

		const content = this.compose(host, body);
		const waited = this.readyTurns;
		if (fresh) {
			this.ready = null;
			this.readyTurns = 0;
		}
		this.landing = true;
		const ops: Op[] = [{ kind: "replace", id, content, recoverable: false }];
		return host
			.propose({ baseRev: host.stats().rev, ops })
			.then(
				(res) => {
					if (this.host !== host) return;
					if (res.results[0]?.applied) {
						this.currentBody = body;
						this.landedContent = content;
						if (fresh) {
							this.refreshes++;
							this.turnsSinceLanding = 0;
						} else this.reasserts++;
						this.publish();
					} else {
						// Clamped (a human took the block, or it was pulled into the tail): try another
						// carrier at the next boundary, keeping the note.
						if (fresh && this.ready === null) this.restoreReady(body, waited);
						if (this.carrierId === id) this.carrierId = null;
						this.ensureCarrier(host);
					}
				},
				() => {
					if (this.host === host && fresh && this.ready === null) this.restoreReady(body, waited);
				},
			)
			.finally(() => {
				this.landing = false;
			});
	}

	private restoreReady(body: string, waited: number): void {
		this.ready = body;
		this.readyTurns = waited;
	}

	/** Header + body, fitted under the cap at the CURRENT calibration. */
	private compose(host: ConductorHost, body: string): string {
		return fitNote(body, this.k.noteMaxTokens, (t) => this.noteCost(host, t));
	}

	/** What `content` costs once it replaces a block (calibrated, block overhead included, +1 rounding). */
	private noteCost(host: ConductorHost, content: string): number {
		return host.countTokens(content) + host.countTokens("x".repeat(4 * BLOCK_OVERHEAD)) + 1;
	}

	// ── span capture ───────────────────────────────────────────────────────────────────────

	/** Record what one of keel-lite's applied transactions dropped, then maybe start an update. */
	private onKeelApplied(host: ConductorHost, res: TxnResult): void {
		const dropped: string[] = [];
		for (const r of res.results) {
			if (!r.applied) continue;
			const op = r.op;
			if (op.kind === "fold") {
				if (r.perId) for (const p of r.perId) p.applied && dropped.push(p.id);
				else dropped.push(...op.ids);
			} else if (op.kind === "replace") {
				dropped.push(op.id);
			} else if (op.kind === "group") {
				const g = r.detail ? host.groups().find((x) => x.id === r.detail) : undefined;
				dropped.push(...(g ? g.memberIds : op.ids));
			}
		}
		if (!dropped.length) return;
		this.trims++;
		this.turnsSinceTrigger = 0;
		this.capture(host, dropped);
		// The epoch just invalidated the prompt cache from its first dropped block on; a finished note
		// lands now so its own cache bust coincides with it.
		if (this.ready !== null) void this.land(host, true);
		if (sumTok(this.buffer) >= this.k.minSpanTokens) this.kick();
		else this.publish();
	}

	/**
	 * Copy the original text of `ids` (plus, for context, the tool calls of the same assistant
	 * message and the call behind each tool result) into the pending buffer, oldest first, each
	 * block at most once per session, then bound the buffer to its most recent `spanMaxTokens`.
	 */
	private capture(host: ConductorHost, ids: readonly string[]): void {
		const blocks = host.blocks();
		const byId = new Map<string, ViewBlock>();
		const callsByMsg = new Map<string, ViewBlock[]>();
		const callByCallId = new Map<string, ViewBlock>();
		for (const b of blocks) {
			byId.set(b.id, b);
			if (b.kind === "tool_call") {
				const key = messageKey(b.id);
				const list = callsByMsg.get(key);
				if (list) list.push(b);
				else callsByMsg.set(key, [b]);
				if (b.callId) callByCallId.set(b.callId, b);
			}
		}
		const want = new Map<string, ViewBlock>();
		const add = (b: ViewBlock | undefined): void => {
			if (!b || b.id === this.carrierId || this.captured.has(b.id) || want.has(b.id)) return;
			if (b.kind === "system" || b.kind === "user") return; // roots stay in context
			want.set(b.id, b);
		};
		for (const id of ids) {
			const b = byId.get(id);
			if (!b) continue;
			add(b);
			if (b.kind === "tool_result" && b.callId) add(callByCallId.get(b.callId));
			if (b.kind === "thinking" || b.kind === "text") for (const c of callsByMsg.get(messageKey(b.id)) ?? []) add(c);
		}
		this.addEntries(host, [...want.values()]);
	}

	private addEntries(host: ConductorHost, blocks: ViewBlock[]): void {
		if (!blocks.length) return;
		for (const b of blocks) {
			this.captured.add(b.id);
			const text = spanText(b, host.textOf(b.id) ?? b.text ?? "", b.kind === "tool_call" ? CALL_MAX_TOKENS : this.k.blockMaxTokens);
			if (!text) continue;
			this.buffer.push({ id: b.id, order: b.order, text, tokens: host.countTokens(text) });
		}
		this.boundBuffer();
	}

	private boundBuffer(): void {
		this.buffer.sort((a, b) => a.order - b.order);
		let total = sumTok(this.buffer);
		while (total > this.k.spanMaxTokens && this.buffer.length > 1) {
			const drop = this.buffer.shift()!;
			total -= drop.tokens;
			this.discardedSpanTokens += drop.tokens;
		}
	}

	/** No trim for `fallbackTurns` turns: checkpoint the most recent blocks the note has not seen. */
	private fallback(host: ConductorHost): void {
		this.turnsSinceTrigger = 0;
		const blocks = host.blocks();
		const pick: ViewBlock[] = [];
		let tokens = 0;
		for (let i = blocks.length - 1; i >= 0 && tokens < this.k.spanMaxTokens; i--) {
			const b = blocks[i];
			if (b.kind === "system" || b.kind === "user" || b.id === this.carrierId || this.captured.has(b.id)) continue;
			pick.push(b);
			tokens += Math.min(b.tokens, b.kind === "tool_call" ? CALL_MAX_TOKENS : this.k.blockMaxTokens);
		}
		if (!pick.length) return;
		this.fallbacks++;
		this.addEntries(host, pick);
		this.kick();
	}

	// ── the update call ────────────────────────────────────────────────────────────────────

	/** Start a note update from the pending buffer, unless one is already in flight. */
	private kick(): void {
		const host = this.host;
		if (!host || this.inflight || !this.buffer.length) {
			this.publish();
			return;
		}
		const spans = this.buffer;
		this.buffer = [];
		const previous = this.ready ?? this.currentBody;
		const req = buildNoteRequest(previous, spans, this.k.noteMaxTokens);
		const ac = new AbortController();
		const gen = this.gen;
		this.abort = ac;
		this.calls++;
		let ok = false;
		const run = async (): Promise<void> => {
			const timer = setTimeout(() => ac.abort(new Error(`note update timed out after ${this.k.timeoutMs}ms`)), this.k.timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			try {
				const res = await abortable(host.complete({ ...req, signal: ac.signal }), ac.signal);
				if (gen !== this.gen) return;
				const body = cleanBody(res.text);
				if (!body) throw new Error("empty note");
				const inTok = res.inputTokens ?? host.countTokens(`${req.system ?? ""}\n${req.prompt}`);
				const outTok = res.outputTokens ?? host.countTokens(res.text);
				if (res.inputTokens === undefined || res.outputTokens === undefined) this.tokensEstimated = true;
				this.inputTokens += inTok;
				this.outputTokens += outTok;
				if (this.ready === null) this.readyTurns = 0; // a newer note keeps the older one's wait
				this.ready = body;
				this.lastError = null;
				ok = true;
			} catch (err) {
				if (gen !== this.gen) return;
				this.failures++;
				this.lastError = err instanceof Error ? err.message : String(err);
				// Keep the old note; the spans go back and ride the next trigger.
				this.buffer = [...spans, ...this.buffer];
				this.boundBuffer();
			} finally {
				clearTimeout(timer);
			}
		};
		this.inflight = run().finally(() => {
			if (gen !== this.gen) return;
			this.inflight = null;
			this.abort = null;
			if (ok && this.buffer.length && sumTok(this.buffer) >= this.k.minSpanTokens) this.kick();
			else this.publish();
		});
		this.publish();
	}

	// ── status ─────────────────────────────────────────────────────────────────────────────

	private publish(): void {
		const host = this.host;
		if (!host) return;
		const note = this.noteStatusText();
		const text = this.keelText ? `${this.keelText} · ${note}` : note;
		host.setStatus(text, {
			...this.keelMetrics,
			note_refreshes: this.refreshes,
			note_calls: this.calls,
			note_failures: this.failures,
			note_fallbacks: this.fallbacks,
			note_reasserts: this.reasserts,
			note_trims_seen: this.trims,
			note_input_tokens: this.inputTokens,
			note_output_tokens: this.outputTokens,
			note_tokens_estimated: this.tokensEstimated,
			note_pending_span_tokens: sumTok(this.buffer),
			note_discarded_span_tokens: this.discardedSpanTokens,
			note_carrier: this.carrierId ?? "",
		});
	}

	private noteStatusText(): string {
		const parts: string[] = [];
		parts.push(this.currentBody === null ? "note: none yet" : `note: ${this.refreshes} refresh${this.refreshes === 1 ? "" : "es"}`);
		if (this.inflight) parts.push("updating");
		else if (this.ready !== null) parts.push("ready");
		if (this.lastError) parts.push(`last update failed (${truncate(this.lastError, 80)}), kept previous`);
		return parts.join(" · ");
	}
}

// ── note request / response ─────────────────────────────────────────────────────────────────

const NOTE_SYSTEM = (maxWords: number): string =>
	[
		"You keep the working notes of a coding agent. Everything you are shown is YOUR OWN earlier work in this same session: your own thinking, the tool calls you made, and the results you got back. Those turns are being trimmed from your context, so these notes are your only memory of them.",
		"",
		"Update your notes: merge your previous notes with what these earlier turns show. Rules:",
		'- Write in the first person, as yourself: "I implemented …", "I ran … → …", "I tried … → failed: …". It was you. Never write "the previous agent", "the assistant", "the model" or "the user\'s agent".',
		"- Keep facts exact: file paths, function and test names, commands, checkpoint numbers, scores, error messages.",
		"- Drop anything superseded by later turns. No narration, no advice, no filler.",
		`- Terse bullet fragments. At most ${maxWords} words in total.`,
		"- Output exactly these five sections, in this order, and nothing else:",
		"",
		...NOTE_SECTIONS.map((s) => `${s}:`),
		"",
		`Under "Tried and failed", pair each attempt with the result I observed. Under "Current failing test / error", copy the key line verbatim if the latest turns show one, else write "none".`,
	].join("\n");

const PROMPT_TAGS = ["previous-notes", "my-earlier-turns"] as const;

export function buildNoteRequest(previous: string | null, spans: readonly SpanEntry[], noteMaxTokens: number): CompletionRequest {
	const maxWords = Math.max(40, Math.floor((noteMaxTokens - 40) * 0.6));
	const turns = spans.map((s) => s.text).join("\n\n");
	const prompt = [
		"<previous-notes>",
		previous ? neutralize(previous) : "(none yet)",
		"</previous-notes>",
		"",
		"<my-earlier-turns>",
		neutralize(turns),
		"</my-earlier-turns>",
		"",
		"Update my progress notes from my previous notes plus these earlier turns of mine. Output only the five sections.",
	].join("\n");
	return { system: NOTE_SYSTEM(maxWords), prompt, maxOutputTokens: Math.ceil(noteMaxTokens * 1.5) };
}

function neutralize(s: string): string {
	return s.replace(new RegExp(`<\\s*\\/?\\s*(${PROMPT_TAGS.join("|")})`, "gi"), (m) => m.replace("<", "&lt;"));
}

/** Strip code fences, an echoed header, and runs of blank lines. */
export function cleanBody(raw: string): string {
	let s = (raw ?? "").replace(/\r\n?/g, "\n").trim();
	s = s.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "").trim();
	const lines = s
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.filter((l, i) => !(i === 0 && /^my progress notes\b/i.test(l.trim())));
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A section heading line ("Tried and failed:", "## Next step:"), never a "- Tried …" bullet. */
const HEADING_RE = /^[\s#*_]*(current goal|built|tried|current failing|next step)\b[^:\n]{0,40}:/i;

/**
 * `NOTE_HEADER` + `body`, cut so that `cost(result) ≤ cap`. Over the cap it first drops the oldest
 * bullets of the two history sections ("Built & verified", "Tried and failed"), largest first, so
 * the goal, the failing test and the next step survive; then cuts whole lines from the end; then
 * characters.
 */
export function fitNote(body: string, cap: number, cost: (text: string) => number): string {
	const render = (ls: readonly string[]) => [NOTE_HEADER, ...ls].join("\n");
	let lines = body.split("\n");
	if (cost(render(lines)) <= cap) return render(lines);

	// 1. Oldest bullets of the history sections, largest section first.
	const sectionOf = (ls: readonly string[]): Array<{ start: number; end: number; name: string }> => {
		const out: Array<{ start: number; end: number; name: string }> = [];
		ls.forEach((l, i) => {
			const m = l.match(HEADING_RE);
			if (m) out.push({ start: i, end: ls.length, name: m[1].toLowerCase() });
		});
		for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
		return out;
	};
	for (;;) {
		if (cost(render(lines)) <= cap) return render(lines);
		const secs = sectionOf(lines).filter((s) => (s.name === "built" || s.name === "tried") && s.end - s.start > 1);
		if (!secs.length) break;
		const size = (s: { start: number; end: number }) => lines.slice(s.start + 1, s.end).join("\n").length;
		const big = secs.reduce((a, b) => (size(b) > size(a) ? b : a));
		const victim = lines.findIndex((l, i) => i > big.start && i < big.end && l.trim() !== "");
		if (victim < 0) break;
		lines = [...lines.slice(0, victim), ...lines.slice(victim + 1)];
	}
	// 2. Whole lines from the end.
	while (lines.length > 1 && cost(render(lines)) > cap) lines = lines.slice(0, -1);
	let text = render(lines);
	if (cost(text) <= cap) return text;
	// 3. Characters.
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (cost(`${text.slice(0, mid)}…`) <= cap) lo = mid;
		else hi = mid - 1;
	}
	text = `${text.slice(0, lo)}…`;
	return text;
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────

function usableCarrier(b: ViewBlock): boolean {
	return (b.kind === "text" || b.kind === "thinking") && !b.held && !b.grouped && !b.protected && isDurableId(b.id);
}

/** One labelled, clipped transcript entry for the note prompt. */
function spanText(b: ViewBlock, text: string, maxTokens: number): string {
	const body = clip(text.trim(), maxTokens);
	if (!body) return "";
	const label =
		b.kind === "thinking" ? "my thinking" : b.kind === "text" ? "my message" : b.kind === "tool_call" ? "my tool call" : `tool result${b.isError ? " (error)" : ""}${b.toolName ? ` · ${b.toolName}` : ""}`;
	return `[${label}]\n${body}`;
}

/** Keep the first 2/3 and last 1/3 of a `maxTokens`-sized window (≈4 chars per token). */
function clip(text: string, maxTokens: number): string {
	const max = maxTokens * 4;
	if (text.length <= max) return text;
	const head = Math.floor(max * (2 / 3));
	const tail = max - head;
	return `${text.slice(0, head)}\n… [${text.length - max} chars elided] …\n${text.slice(text.length - tail)}`;
}

function sumTok(entries: readonly SpanEntry[]): number {
	let n = 0;
	for (const e of entries) n += e.tokens;
	return n;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

function join(a: void | Promise<void>, b: void | Promise<void>): void | Promise<void> {
	if (!a && !b) return;
	return Promise.all([a, b]).then(() => undefined);
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}

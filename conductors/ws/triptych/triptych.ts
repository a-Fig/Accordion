/*
 * conductors/ws/triptych/triptych.ts — the "Triptych" conductor: pressure-gated thirds.
 *
 * The owner's design (research/skeleton-lab/CONDUCTOR-PLAN.md on the research branch,
 * claude/code-skeleton-extraction-rv0ovo — grilled and settled 2026-07-25): divide the context
 * into three bands and treat each differently.
 *
 *   bottom  — the most recent ~⅓ of the cap (raw tokens, measured from the tip; never smaller
 *             than the host's protected tail). Untouched.
 *   middle  — older than the bottom band, not yet summarized. Code-file `tool_result` reads
 *             (doorman's reject-biased `classifyCodeRead`) are replaced with a tree-sitter L2
 *             SKELETON — signatures kept, bodies elided — as a labeled, RECOVERABLE `replace`
 *             fold (`recoverable: true` ⇒ the `{#code FOLDED}` tag, so `recall` still reaches
 *             the full source). Everything else rides untouched (code-only v1).
 *   top     — older than ~⅔ of the cap. Swept into ONE lossy summary group using
 *             compaction-naive's `COMPACTION_SYSTEM` prompt verbatim — untagged, agent-
 *             unrecoverable, recursive. Exactly the foil's behavior, deliberately.
 *
 * PRESSURE-GATED: the conductor does nothing until the visible window first crosses the shared
 * 90% high-water mark (`TRIGGER`). That first crossing arranges the context into thirds in one
 * pass; from then on activation is STICKY — skeletons keep applying as blocks age past the
 * bottom boundary, while summaries (an LLM call each) re-run only at each subsequent 90%
 * crossing, recursively, exactly like compaction-naive.
 *
 * FULLY EXCLUSIVE (owner decision): locks `human-steering` + `agent-unfold`, compaction-naive's
 * posture. `recall` is never lockable (sacred tier), so the tagged skeletons still give the
 * agent read-access to elided bodies; the summary group is the one one-way door.
 *
 * Two implementer decisions, flagged in the plan:
 *   - When skeletonized code ages into the summary, the summarizer is fed the SKELETON
 *     (`promptTextOf` override) — the conversation as the agent experienced it, and the owner
 *     chose lossy for that band anyway.
 *   - The summary trigger's visible-window math credits skeleton savings (`extraSavedTokens`
 *     override) — otherwise the 90% mark would re-fire while the real wire still has room.
 *
 * RUNS OUT OF PROCESS (repo-only v1, thermocline's pattern): the extension spawns
 * `conductors/ws/triptych/runner.mjs`, which imports the committed `triptych-sdk.mjs` bundle and
 * dials back as `?role=conductor&token=…`. The tree-sitter engine (wasm grammars, async init,
 * disk I/O) therefore lives in the runner's own process — never in the extension, never
 * anywhere near the `context` hook. The engine is INJECTED (`Skeletonizer` below) so this class
 * stays dependency-free: unit tests hand it a fake; the runner hands it `./skeleton.mjs`.
 *
 * All summary machinery — the 90% trigger, attempt keys, sticky failure status, the
 * `<conversation>` prompt template with its injection neutralizer, output-token reservation —
 * is inherited from `AgedSummaryConductor`; this file owns only the banding, the skeleton
 * folds, and the triptych-branded status strings.
 */
import { AgedSummaryConductor, TRIGGER, sumTokens, truncateForStatus } from "../../in-process/agedSummaryConductor";
import { COMPACTION_SYSTEM } from "../../in-process/compaction-naive/compaction-naive";
import { classifyCodeRead } from "../../in-process/doorman/classify";
import type { Command, ConductorView } from "../../../core/conductor/view";
import type { ConductorHost, LockName, ViewBlock } from "../../../core/conductor/contract";

/**
 * The injected skeleton engine. `runner.mjs` supplies the real tree-sitter implementation
 * (`./skeleton.mjs`); tests supply a fake. Kept minimal on purpose — the conductor needs
 * exactly three capabilities and no more.
 */
export interface Skeletonizer {
	/** Async engine init (wasm load, disk I/O — runner process only). Idempotent. */
	init(): Promise<void>;
	/** True once `init()` has resolved. */
	ready(): boolean;
	/**
	 * The L2 skeleton of `source`, or null when the language is unsupported/undetectable or the
	 * engine is not ready. MUST be deterministic and MUST NOT throw.
	 */
	skeletonize(path: string | undefined, source: string): string | null;
}

/**
 * Decline-to-fold gate: the labeled skeleton must come in at or under this fraction of the
 * block's original text, or the block is left alone. All-contract files (interfaces/types with
 * no bodies — RESULTS.md finding 5) barely shrink; replacing them would cost tag+header overhead
 * to destroy exactly what the skeleton exists to preserve.
 */
const SHRINK_MAX = 0.7;

/** Skip skeletonizing tiny results outright — below this many tokens the header+tag overhead
 *  eats most of the saving and the read is cheap to keep whole anyway. */
const MIN_SKELETON_TOKENS = 700;

export class TriptychConductor extends AgedSummaryConductor {
	readonly id = "triptych";
	readonly label = "Triptych";
	readonly description = "Pressure-gated thirds: raw recent band, code-skeleton middle band, lossy compaction summary top band.";

	/**
	 * Involvement locks (ADR 0011): fully exclusive, compaction-naive's posture (owner decision).
	 * `human-steering` keeps the summarized region contiguous (a mid-region pin would split the
	 * single group); `agent-unfold` declares the agent cannot reopen a skeleton — `recall` (never
	 * lockable) remains its read path to elided bodies. `tail-size` is deliberately NOT locked:
	 * the bottom band respects whatever tail the human sets.
	 */
	readonly locks: readonly LockName[] = ["human-steering", "agent-unfold"];

	protected readonly systemPrompt = COMPACTION_SYSTEM;
	protected readonly priorTag = "previous-summary";

	/** Sticky pressure gate: false until the visible window first crosses `TRIGGER`; never unset
	 *  until detach/re-attach. */
	private active = false;

	/**
	 * Per-block skeleton cache: block id → the full labeled replacement content, or null for
	 * "evaluated and declined" (not code / unsupported language / didn't shrink) so a declined
	 * block is never re-parsed every pass. Block text is immutable once appended, so id-keyed
	 * caching is safe; the map is reset on attach.
	 */
	private skelCache = new Map<string, string | null>();

	constructor(private readonly skel: Skeletonizer) {
		super();
	}

	attach(host: ConductorHost): void {
		this.active = false;
		this.skelCache = new Map();
		super.attach(host);
		// Kick the (idempotent) engine init off-path; when it resolves, re-run so the middle band
		// materializes without waiting for the next turn. Init failure degrades to summaries-only.
		void this.skel.init().then(
			() => this.rerun(),
			(err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.host.setStatus(truncateForStatus(`Triptych: skeleton engine failed to load — summaries only (${msg})`));
			},
		);
	}

	// ── the triptych pass ──────────────────────────────────────────────────────────

	conduct(view: ConductorView): Command[] | null {
		// STICKY ACTIVATION. Before the first fold there are no savings of ours, so the visible
		// window IS the raw total — no need for the base class's savings-adjusted arithmetic here.
		const cap = this.effectiveCap(view);
		if (!this.active && cap > 0 && view.blocks.length > 0 && sumTokens(view.blocks) >= cap * TRIGGER) {
			this.active = true;
		}

		// The inherited summary machinery (trigger, attempt keys, coverage group emission) runs
		// against the TOP band only — `agedBoundaryIndex` below confines it. Returns null exactly
		// while the FIRST completion is in flight (hold everything; the skeletons land on the
		// resolve handler's rerun a moment later).
		const summary = super.conduct(view);
		if (summary === null) return null;
		if (!this.active) return summary; // pre-activation: nothing else to say

		return [...summary, ...this.skeletonCommands(view)];
	}

	// ── band geometry ────────────────────────────────────────────────────────────

	/** The effective cap the bands are thirds of — same clamp the base trigger uses. */
	private effectiveCap(view: ConductorView): number {
		return view.contextWindow != null ? Math.min(view.budget, view.contextWindow) : view.budget;
	}

	/**
	 * Band boundaries, measured in RAW (full) tokens walking from the newest block backward:
	 *   bottom band = blocks[bottomStart ..)  — the suffix that first accumulates cap/3.
	 *   middle band = blocks[topEnd .. bottomStart)
	 *   top band    = blocks[0 .. topEnd)     — everything older than 2·cap/3 from the tip.
	 * Raw tokens on purpose: boundaries measure AGE in original content, so they do not lurch
	 * when a fold changes a block's visible cost. `bottomStart` is clamped to the protected-tail
	 * boundary so the untouched band always contains the tail (the tail is never ours to touch).
	 */
	private bands(view: ConductorView): { bottomStart: number; topEnd: number } {
		const third = this.effectiveCap(view) / 3;
		let bottomStart = 0;
		let topEnd = 0;
		if (third > 0) {
			let cum = 0;
			let haveBottom = false;
			for (let i = view.blocks.length - 1; i >= 0; i--) {
				cum += view.blocks[i].tokens;
				if (!haveBottom && cum >= third) {
					bottomStart = i; // the crossing block is generous — it stays in the bottom band
					haveBottom = true;
				}
				if (cum >= 2 * third) {
					topEnd = i; // the crossing block stays in the middle band; top = [0, i)
					break;
				}
			}
			if (!haveBottom) bottomStart = 0; // the whole log fits in one third — all bottom
		}
		bottomStart = Math.min(bottomStart, view.protectedFromIndex);
		topEnd = Math.min(topEnd, bottomStart);
		return { bottomStart, topEnd };
	}

	// ── AgedSummaryConductor hooks ───────────────────────────────────────────────

	/** The summary machinery may sweep ONLY the top band — and nothing at all pre-activation. */
	protected agedBoundaryIndex(view: ConductorView): number {
		if (!this.active) return 0;
		return this.bands(view).topEnd;
	}

	/** Credit skeleton savings to the trigger's visible window (implementer decision #2). */
	protected extraSavedTokens(view: ConductorView): number {
		let saved = 0;
		for (const b of view.blocks) {
			if (!b.folded || b.grouped || b.held) continue;
			if (this.skelCache.get(b.id) == null) continue; // not one of our skeleton folds
			saved += Math.max(0, b.tokens - b.foldedTokens);
		}
		return saved;
	}

	/** Feed the summarizer the skeleton for skeletonized blocks (implementer decision #1). */
	protected promptTextOf(b: ViewBlock): string {
		const skel = this.skelCache.get(b.id);
		return skel != null ? skel : (b.text ?? "").trim();
	}

	// ── the middle band: skeleton folds ──────────────────────────────────────────

	/**
	 * One labeled `replace` (recoverable ⇒ `{#code FOLDED}`-tagged) per classified code read
	 * older than the bottom band that the summary group does not already cover. Blocks in the
	 * not-yet-summarized part of the top band are included on purpose — they benefit from the
	 * skeleton until a summary run sweeps them (at which point `ViewConductor`'s diffing clears
	 * the replace as the block enters the group).
	 */
	private skeletonCommands(view: ConductorView): Command[] {
		if (!this.skel.ready()) return [];
		const { bottomStart } = this.bands(view);
		const limit = Math.min(bottomStart, view.protectedFromIndex, view.blocks.length);
		if (limit <= 0) return [];

		let callById: Map<string, ViewBlock> | null = null; // built lazily — most passes see no new candidates
		const out: Command[] = [];
		for (let i = 0; i < limit; i++) {
			const b = view.blocks[i];
			if (b.kind !== "tool_result" || b.held || b.grouped) continue;
			if (b.tokens < MIN_SKELETON_TOKENS) continue;
			if (this.coveredIds.has(b.id) && this.includeInGroup(b)) continue; // the summary group's, not ours
			let content = this.skelCache.get(b.id);
			if (content === undefined) {
				if (callById === null) {
					callById = new Map();
					for (const c of view.blocks) if (c.kind === "tool_call" && c.callId) callById.set(c.callId, c);
				}
				content = this.evaluateSkeleton(b, callById);
				this.skelCache.set(b.id, content);
			}
			if (content === null) continue; // evaluated and declined
			out.push({ kind: "replace", id: b.id, content, recoverable: true });
		}
		return out;
	}

	/** Classify → skeletonize → label → shrink-gate. Null = decline (cached, never re-parsed). */
	private evaluateSkeleton(b: ViewBlock, callById: Map<string, ViewBlock>): string | null {
		const info = classifyCodeRead(b, callById);
		if (info === null) return null;
		const skeleton = this.skel.skeletonize(info.path, info.source);
		if (skeleton === null) return null;
		const srcLines = countLines(info.source);
		const content = `${skeletonHeader(info.path, srcLines)}\n${skeleton}`;
		// Decline gate vs the block's ORIGINAL text (wrappers included — that is what the wire pays).
		const original = b.text ?? "";
		if (original.length === 0 || content.length > original.length * SHRINK_MAX) return null;
		return content;
	}

	// ── summary prompt + status strings (subclass-owned by the AgedSummaryConductor contract) ──

	/* The two instruction strings are compaction-naive's VERBATIM (the owner's spec is "the same
	 * prompt as compaction naive", end to end). They are protected methods on that class, so the
	 * strings are mirrored here rather than imported — keep in lockstep with
	 * `NaiveCompactionConductor.firstPassInstruction` / `.recursiveInstruction`. */

	protected firstPassInstruction(): string {
		return "Create a structured summary from the conversation history above.";
	}

	protected recursiveInstruction(): string {
		return (
			'Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE ' +
			"all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move " +
			'completed work into "Progress" and revise "Next Steps" accordingly. Preserve exact file paths, function ' +
			"names, and error messages when known. Carry forward every verbatim user message from the previous " +
			'summary and append the new user messages from the conversation — all still reproduced word-for-word in ' +
			'"## User messages".'
		);
	}

	protected formatText(count: number, body: string): string {
		return `[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n${body}`;
	}

	protected emptyOutputMessage(_count: number): string {
		return "Triptych: summary failed — model returned empty output";
	}

	protected windowTooTightMessage(inputTokens: number, contextWindow: number): string {
		return `Triptych: summary needs a bigger window — input ≈ ${inputTokens} tokens leaves no room to write in a ${contextWindow}-token window`;
	}

	protected rejectMessage(err: unknown): string {
		return truncateForStatus(`Triptych: summary failed — ${err instanceof Error ? err.message : String(err)}`);
	}

	protected unavailableMessage(): string {
		return "Triptych: summary unavailable — waiting for live model link";
	}
}

/**
 * The one-line label riding above every skeleton so the agent knows what it is looking at (owner
 * requirement: "it should be labeled as such so the agent knows"). The `{#code FOLDED}` tag the
 * host prepends is the recovery pointer; this line says what the compressed form IS.
 */
export function skeletonHeader(path: string | undefined, srcLines: number): string {
	const what = path !== undefined ? path : "a code file";
	return `[code skeleton of ${what} — signatures kept, bodies elided (${srcLines} source lines). Use recall with the fold code above for the full file.]`;
}

function countLines(s: string): number {
	if (s.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}

export { COMPACTION_SYSTEM };

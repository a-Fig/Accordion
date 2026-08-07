/*
 * core/conductors/doorman/doorman.ts — the birth-fold demonstration conductor.
 *
 * Doorman stands at the door: it intercepts GIANT fresh `tool_result` blocks on their way
 * OUT to the model, before they ever ride the wire. Code files get skeletonized in place
 * (signatures kept, bodies elided — recoverable via `unfold`/`recall`); other giant dumps
 * get birth-folded to the engine's own digest. It exists so a human can watch birth-fold
 * (ADR 0018) actually happen: a huge tool_result, born *inside* the protected working tail
 * on its very first appearance, gets compressed before the model ever sees it whole — a
 * strategy move `Truth.canFold`'s birth-fold exemption alone makes possible (no `tail-size`
 * lock, no consent gate, no LLM call).
 *
 * This is a RAW evented conductor (not `ViewConductor`): birth-fold is a decision that must
 * be made at *wire-departing* time, not at the next `turn-committed` replan — by the time a
 * turn settles, the block has already gone out once. `holdWireUpToMs: 150` tells the host it
 * may hold the departing wire briefly for a last-moment proposal; every decision here is
 * synchronous CPU (string classification + string skeletonization, no `host.complete`). The
 * on(`wire-departing`) handler is `async` only because `host.propose` is async by contract
 * (v2) — but the propose is INVOKED synchronously, so the fold lands in Truth inside the host's
 * synchronous event dispatch, before the "sent" cursor advances (see `TestHost.departWire`); the
 * one `await` merely defers reading the per-op results for the `handled` bookkeeping + status.
 * The hold is comfortably sub-frame in practice (it settles on a microtask, far under 150 ms).
 *
 * Collaborative: `locks` is omitted. Doorman never claims authority over a block — a human
 * pin or fold keeps it as-is (the `held` gate below), and the moment the agent (or the
 * human) unfolds one of doorman's folds, `Truth` stamps a non-null `override` on it, which
 * makes `canFold` refuse every future strategy attempt on that id, human-override-style,
 * forever (see the `handled` bookkeeping below for the same guarantee belt-and-braces).
 *
 * Design carve-outs (see README.md for the human-readable version):
 *   - Only the NEWEST-appearing giant tool_results are candidates: `tokens >= MIN_SKELETON_
 *     TOKENS` (ported from the code-skeleton reference), not an error result, not held
 *     (pinned / already manually folded or unfolded), and — the one judgment call — NOT in
 *     the newest turn. A block born in the turn the user is mid-conversation with may be
 *     exactly what they just asked for; doorman leaves the current turn alone and only acts
 *     on giant results that are already at least one turn old (but still fresh — never sent).
 *   - `classifyCodeRead` (ported verbatim from the deleted code-skeleton conductor, ADR 0016)
 *     decides code vs. not-code. A code classification that isn't actually WORTH skeletonizing
 *     (no elidable body, or the skeleton wouldn't shrink the block enough) is left ALONE this
 *     pass — doorman does not fall back to a generic fold for it (unlike the old code-skeleton
 *     conductor's budget-driven passes; doorman has no budget loop, it is a birth-fold demo).
 *   - Every OTHER giant fresh result (grep dumps, JSON blobs, directory listings, …) gets a
 *     plain `{ kind: "fold", ids: [id] }` — no custom digest, so the engine's own per-kind
 *     digest applies. That digest still carries the `{#code FOLDED}` tag (recallable,
 *     unfoldable) exactly like a human fold would.
 */
import type { Conductor, ConductorHost, HostEvent, ViewBlock } from "../../conductor/contract";
import type { Op } from "../../ops";
import { classifyCodeRead, type CodeReadInfo } from "./classify";
import { detectLang, skeletonize } from "./skeletonize";

/** Below this, a tool_result isn't worth intercepting at all — ported from the code-skeleton
 *  reference's own floor (the fixed header/tag overhead wouldn't be worth a lossy view). */
const MIN_SKELETON_TOKENS = 1500;

/** A skeleton must cost no more than this fraction of the full block to be worth replacing —
 *  ported verbatim from the code-skeleton reference's `MAX_SKELETON_RATIO`. */
const MAX_SKELETON_RATIO = 0.6;

/** Rough token cost of the engine's `{#code FOLDED}` tag + per-block overhead layered onto
 *  the skeleton body we supply — kept the saving estimate conservative, same as the reference. */
const TAG_OVERHEAD_TOKENS = 10;

/** A computed, worth-it skeleton for one candidate block. */
interface Skeleton {
	/** Header + structural skeleton the agent will see (the host prepends the `{#code FOLDED}` tag). */
	content: string;
	/** Estimated tokens saved versus the full block. Always > 0 (the worth-it gate guarantees it). */
	saved: number;
}

export class DoormanConductor implements Conductor {
	readonly id = "doorman";
	readonly label = "Doorman";
	readonly description =
		"Intercepts giant fresh tool results at the door before they ride the wire: skeletonizes code in place, birth-folds the rest. Demonstrates birth-fold (ADR 0018).";
	// Collaborative — no `locks`: a human override always wins, no consent gate.
	readonly holdWireUpToMs = 150;

	private host: ConductorHost | null = null;
	private off: (() => void) | null = null;
	/** Ids doorman has already replaced/folded — never revisited, so an agent/human unfold is
	 *  never nagged at by a re-proposal on a later pass (belt-and-braces alongside the engine's
	 *  own override clamp, which already refuses the retry). */
	private handled = new Set<string>();

	attach(host: ConductorHost): void {
		this.host = host;
		this.off = host.on((e) => this.onEvent(e));
	}

	detach(): void {
		this.off?.();
		this.off = null;
		this.host?.setStatus(null);
		this.host = null;
		this.handled.clear();
	}

	private onEvent(e: HostEvent): void | Promise<void> {
		// Only wire-departing matters to doorman — it is a wire-departing-time decision, not a
		// turn-based replan. (No `state-changed`/`resync` handling: `handled` only ever grows, and
		// a fresh attach starts it empty, exactly the state a resync would want anyway.) Returning
		// the promise lets the host await the handler settling for its bounded wire-departing hold.
		if (e.type === "wire-departing") return this.onWireDeparting(e);
	}

	/**
	 * Classification and skeletonization are pure synchronous string operations; the whole
	 * candidate scan + the `host.propose` INVOCATION happen synchronously inside the host's event
	 * dispatch, so the fold lands before the sent cursor advances. The handler is `async` only to
	 * `await` the async-by-contract (v2) `propose` result for `handled`/status bookkeeping — that
	 * awaited tail settles on a microtask, comfortably inside `holdWireUpToMs`.
	 */
	private async onWireDeparting(e: Extract<HostEvent, { type: "wire-departing" }>): Promise<void> {
		const host = this.host;
		if (!host || !e.freshIds.length) return;

		const blocks = host.blocks();
		let latestTurn = 0;
		for (const b of blocks) if (b.turn > latestTurn) latestTurn = b.turn;

		// callId → tool_call block, so the classifier can recover each read's path/command.
		const callById = new Map<string, ViewBlock>();
		for (const b of blocks) if (b.kind === "tool_call" && b.callId) callById.set(b.callId, b);

		const ops: Op[] = [];
		const opIds: string[] = []; // parallel to `ops`, for reconciling `handled` after propose
		let skeletonCount = 0;
		let foldCount = 0;
		let skeletonSaved = 0;
		let foldSaved = 0;

		for (const id of e.freshIds) {
			if (this.handled.has(id)) continue; // already acted on — never revisit
			const b = host.get(id);
			if (!b) continue;
			if (b.kind !== "tool_result") continue;
			if (b.isError) continue;
			if (b.held) continue; // a human override (pin/fold/unfold) already owns this block
			if (b.grouped) continue; // a folded group's overlay owns it, not us
			if (b.tokens < MIN_SKELETON_TOKENS) continue;
			if (b.turn >= latestTurn) continue; // the user may have just asked for exactly this

			const info = classifyCodeRead(b, callById);
			if (info) {
				const sk = this.skeletonFor(host, b, info);
				if (!sk) continue; // classified as code, but not worth it — leave alone
				ops.push({ kind: "replace", id, content: sk.content, recoverable: true });
				opIds.push(id);
				skeletonCount++;
				skeletonSaved += sk.saved;
			} else {
				// Not a code-file read, but still a giant fresh result — the plain birth-fold.
				ops.push({ kind: "fold", ids: [id] });
				opIds.push(id);
				foldCount++;
				foldSaved += b.tokens - b.foldedTokens;
			}
		}

		if (!ops.length) return;

		const baseRev = host.stats().rev;
		const res = await host.propose({ baseRev, ops });
		res.results.forEach((r, i) => {
			if (r.applied) this.handled.add(opIds[i]);
		});

		this.publishStatus(skeletonCount, foldCount, skeletonSaved, foldSaved);
	}

	/** Compute the skeleton for a classified code read, or null if it isn't worth replacing.
	 *  Worth-it check ported verbatim from the code-skeleton reference: it must actually elide
	 *  something, the substitution must cost no more than `MAX_SKELETON_RATIO` of the full
	 *  block, and it must genuinely save tokens. */
	private skeletonFor(host: ConductorHost, b: ViewBlock, info: CodeReadInfo): Skeleton | null {
		const lang = detectLang(info.path, info.source);
		const sk = skeletonize(info.source, lang);
		if (sk.elidedLines === 0) return null; // nothing to elide → no point

		const header = `⟨code skeleton · ${info.path ?? "file"} · ${sk.totalLines}L → ${sk.keptLines}L · ${sk.elidedLines} elided · call unfold for full source⟩`;
		const content = `${header}\n${sk.skeleton}`;

		const skeletonTokens = host.countTokens(content) + TAG_OVERHEAD_TOKENS;
		const saved = b.tokens - skeletonTokens;
		if (saved <= 0 || skeletonTokens > b.tokens * MAX_SKELETON_RATIO) return null;

		return { content, saved };
	}

	private publishStatus(skeletons: number, folds: number, skeletonSaved: number, foldSaved: number): void {
		if (!this.host) return;
		const parts: string[] = [];
		if (skeletons) parts.push(`skeletonized ${skeletons} (−${fmtTok(skeletonSaved)})`);
		if (folds) parts.push(`folded ${folds} (−${fmtTok(foldSaved)})`);
		if (!parts.length) return; // nothing acted on this pass — leave any prior status standing
		this.host.setStatus(parts.join(", "), {
			skeletons,
			folds,
			tokens_saved: skeletonSaved + foldSaved,
		});
	}
}

/** `12400` → `"12.4k"`; small values pass through as plain integers. */
function fmtTok(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.max(0, Math.round(n))}`;
}

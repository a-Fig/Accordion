/*
 * digest.ts — what a folded block collapses to.
 *
 * Deterministic, per-kind. The point of typed blocks is that each kind keeps a
 * different essence when folded: a tool_call keeps WHAT it did, a tool_result
 * keeps only its shape and a taste of WHAT it saw. No LLM here yet — these are
 * structured digests so behaviour is reproducible and debuggable.
 *
 * Every digest carries a leading `{#<code> FOLDED}` tag. This is the engine's
 * source-of-truth string: it is what the GUI renders for a folded block, what
 * `digestTokens` counts, AND (in live mode) the exact text the agent receives in
 * place of the folded content. The agent reads the short `code` from the tag and
 * calls the `unfold` tool with it to pull the block back to full content. Keeping the
 * tag here — not bolted on at the wire — guarantees the GUI shows precisely what the
 * model sees and the saved-tokens figure includes the tag's real cost.
 *
 * The code is a short HASH of the durable block id, not the id itself: a raw id is a
 * UUID/timestamp (`a:f2965ed9-…-d93e8c55c59e:p0`) — unreadable line-noise repeated on
 * every folded block. The hash is a pure function of the id, so it needs no state and
 * is globally stable (same block → same code, every session). A 6-char base36 space
 * (~2.2B) keeps collisions rare; the rare collision is handled by `resolveUnfold`
 * unfolding every folded block that shares the code (cheap and harmless).
 *
 * Part of the framework-free `core/` package — one definition shared by the app and the
 * extension so the two can never drift on what a fold looks like.
 */
import type { Block, BlockKind, Group } from "./types";
import { estTokens, clip, firstLine, BLOCK_OVERHEAD } from "./tokens";

/**
 * Kinds that the live link can actually fold and send to the agent (mirrored by
 * `computeFoldOps` / `applyPlan`). A `tool_call` is never folded (it would orphan its
 * result) and a `user` block (intent) is never folded. ONLY these kinds get a
 * `{#code FOLDED}` tag — so the agent is never shown a handle for a block it can't
 * actually unfold. Defined here (the engine) so the live layer imports one definition.
 */
export const FOLDABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["text", "thinking", "tool_result"]);

/**
 * The ONE foldability predicate, shared by the view and the wire. A block may be folded —
 * its content substituted by a digest on the agent's wire — iff its KIND is foldable. This
 * is the single gate `Truth.canFold()` / `isFolded` AND the wire
 * (`computeFoldOps` / `resolveUnfold`) all consult, so the screen can NEVER show a per-block
 * fold the wire would refuse. That refusal is the "UI lie" this predicate exists to make impossible: a folded
 * `tool_call` whose tile recesses and whose tokens are counted as saved, while the agent
 * still receives the block whole.
 *
 * KIND ONLY — deliberately content- and id-independent. The durable-id guard (`isDurableId`)
 * is a LIVE-WIRE EMIT concern, NOT part of foldability: the on-disk / demo / Claude Code parse
 * assigns non-durable ids (`<eventId>:p<j>`), and those read-only sessions must still fold by
 * kind in every mode (preview === steering — see CLAUDE.md). So durable-id stays where it
 * belongs, inside `computeFoldOps`, and is intentionally not mirrored here. Group collapse
 * (ADR 0006) is a SEPARATE mechanism — structural whole-message removal with its own rules —
 * and may legitimately include `tool_call`/`user`; this predicate governs only per-block
 * content folding, never group collapse.
 */
export function wireFoldable(b: Block): boolean {
	return FOLDABLE_KINDS.has(b.kind);
}

/**
 * Kinds that NO actor — human, conductor, or agent — may fold, group, pin, or replace: the BOLTED
 * kinds. Today exactly `system` (the harness's own prompt). A named set rather than scattered
 * `kind === "system"` comparisons so a second bolted kind is a one-line change here, not an audit of
 * every op handler.
 */
const BOLTED_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["system"]);

/**
 * Is this block BOLTED — permanently exempt from every steering action, by every actor?
 *
 * Bolted is a property of the KIND and never lifts. It is deliberately distinct from the two other
 * "you can't touch this" states in the engine:
 *   • HELD (`Block.override !== null`) is a human decision the human can release;
 *   • PROTECTED (the working tail) is positional and moves as the tail resizes.
 * Bolted is neither: the block is a fixed floor of the context, and there is no state in which it
 * becomes steerable.
 *
 * WHY THIS EXISTS ALONGSIDE `wireFoldable`. Per-block content folding is already refused for free —
 * `system` is not in `FOLDABLE_KINDS`, so `wireFoldable` returns false and `canFold`/`opFold`/
 * `opReplace`/`computeFoldOps`/`resolveUnfold` all decline without any new code. What foldability
 * does NOT cover is every OTHER path that can change what the model receives:
 *   • GROUP COLLAPSE (ADR 0006) — a separate structural mechanism that legitimately swallows
 *     non-foldable kinds (`user`, `tool_call`), so `wireFoldable` is silent about it;
 *   • PIN / UNPIN — an override on a block, unrelated to foldability;
 *   • the human-facing affordances that read a block's steerability directly.
 * `isBolted` is the single predicate those paths consult, and `Truth.apply` checks it FIRST in every
 * relevant op so a conductor learns the PERMANENT reason (`"bolted"`) rather than an incidental one
 * — `"not-foldable"` reads as "wrong kind, try another block", `"noop"` reads as "already in that
 * state, retry later", and both would send a strategy back around a loop it can never win.
 *
 * Accepts anything carrying a `kind` — a `Block` (Truth's own log) or a `ViewBlock` (what a
 * conductor sees) — so the two sides can never diverge on a hand-rolled second copy of the rule.
 */
export function isBolted(b: { kind: BlockKind }): boolean {
	return BOLTED_KINDS.has(b.kind);
}

/**
 * Short, stable handle for a block, derived purely from its durable id (FNV-1a → base36,
 * 6 chars). Stateless and deterministic so the engine, the live link, and the
 * `accordion-context-folding` skill never drift. Not collision-free by construction, but
 * a 6-char base36 space (~2.2B) makes a collision vanishingly rare even across a
 * thousand-block session (~0.02%); the rare collision is handled by `resolveUnfold`
 * restoring ALL folded blocks that carry the code.
 */
export function foldCode(id: string): string {
	let h = 0x811c9dc5; // FNV-1a 32-bit
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/** The folded-block marker the agent sees and passes back to `unfold`, e.g. `{#3f9a2c FOLDED}`. */
export function foldTag(id: string): string {
	return `{#${foldCode(id)} FOLDED}`;
}

/**
 * A leading `{#code FOLDED}` tag (plus any surrounding whitespace). ONE definition, shared by
 * `Truth` (which strips it so the engine stays the sole author of the tag) and `agentView`
 * (which reads its PRESENCE as the agent's permission to reach the block).
 */
export const LEADING_FOLD_TAG = /^\s*\{#[0-9a-z]{6} FOLDED\}\s*/;

/**
 * Does this wire text carry a fold tag — i.e. did the ENGINE author it?
 *
 * The tag is the agent's handle: it is the only way a code ever reaches the model, so text without
 * one is text the agent was never given a way to ask about. Two substitutions are deliberately
 * untagged, and this predicate is what makes that absence mean something:
 *   • a HUMAN-authored digest (`opFold` with `op.digest`) — the human's own words replace the
 *     block, and an `unfold` handle would let the agent undo exactly the curation they just did;
 *   • a conductor's non-recoverable `replace` (`recoverable: false`), which is verbatim by contract.
 * `resolveUnfold`/`resolveRecall` consult this so a `foldCode` HASH COLLISION with some other
 * block's visible tag can never restore one of them by accident.
 */
export function hasFoldTag(text: string): boolean {
	return LEADING_FOLD_TAG.test(text);
}

/**
 * Does this wire text carry the fold tag for THIS SPECIFIC id — the only tag that would actually
 * resolve back to it?
 *
 * `hasFoldTag` asks the weaker question ("is there a tag at all"), and the difference is a real
 * hole: a digest whose text begins with some OTHER block's tag — pasted by a human, or baked in by
 * a conductor that hand-authored one — would pass the weak check and become reachable by its own
 * code, which is exactly the accidental-restore path the tag rule exists to close. Reachability
 * must be decided by the handle the model was ACTUALLY given, so `agentView` asks this one.
 */
export function hasOwnFoldTag(text: string, id: string): boolean {
	const m = text.match(LEADING_FOLD_TAG);
	return m ? m[0].includes(`{#${foldCode(id)} `) : false;
}

/**
 * What a human-emptied block collapses to on the wire.
 *
 * A user who clears the digest editor is saying "the agent should not see this block". Per-block
 * folding cannot honour that literally: it is content SUBSTITUTION, and `applyPlan` refuses any
 * fold op with an empty `digestText` (`core/wire.ts`) — which would ship the block WHOLE, the exact
 * UI lie this repo forbids. Removing a block outright is only legal where the wire's message count
 * may change, i.e. a GROUP drop (`Group.digest === null`), which carries the tool-pair fixpoint and
 * the role-validity floor to keep the result provider-valid. So the block-level answer is the
 * smallest honest placeholder: three tokens that say plainly that something was here and is gone.
 *
 * Untagged by construction — it is a human-authored digest, so `hasFoldTag` is false for it and the
 * agent gets no handle to unfold or recall what was removed.
 */
export const EMPTY_DIGEST = "{empty}";

/**
 * Per-block memo of the (immutable) digest string and its token cost. `digest(b)` reads
 * only fields fixed at parse time — kind, text, id, toolName, isError, tokens — and folding
 * never touches any of them (it flips override/autoFolded/by/subst). So the result is
 * invariant for a block's lifetime, yet `refold()` recomputes it twice per fold candidate and
 * every `liveTokens` read recomputes it per folded block; each call re-runs the FNV hash plus a
 * couple of text splits. A WeakMap keyed by the block makes those repeats free and is
 * GC-friendly (no cross-session leak: the entry dies with the block).
 *
 * TRIPWIRE: there is no invalidation. This is sound ONLY because a committed block's content
 * fields are never mutated in place (the live resend path drops duplicate ids rather than
 * overwriting; applyPlan clones). If a future feature ever mutates an existing block's
 * `text`/`tokens` (e.g. streaming partial-text growth into a committed block), it MUST clear
 * both caches for that block, or the rendered digest and saved-tokens accounting go stale.
 */
const digestCache = new WeakMap<Block, string>();
const digestTokenCache = new WeakMap<Block, number>();

/**
 * The full folded representation. Foldable kinds get the `{#<code> FOLDED}` tag followed
 * by the per-kind body; non-foldable kinds (user / tool_call) get the body alone — they
 * are never sent folded to the agent, so tagging them would show a handle the agent can
 * never use and make the GUI render diverge from what the model actually sees.
 */
export function digest(b: Block): string {
	const cached = digestCache.get(b);
	if (cached !== undefined) return cached;
	const body = digestBody(b);
	const out = FOLDABLE_KINDS.has(b.kind) ? `${foldTag(b.id)} ${body}` : body;
	digestCache.set(b, out);
	return out;
}

/** The per-kind essence kept when a block is folded (without the tag). */
function digestBody(b: Block): string {
	switch (b.kind) {
		case "system":
			// Unreachable in practice — a bolted block is never folded, so nothing ever renders this.
			// Present so the switch stays exhaustive over `BlockKind` and a future caller that asks for
			// a system block's digest (an Inspector "what would this look like folded" probe, say) gets
			// something sane rather than the `default` catch-all.
			return "system prompt";
		case "user":
			return "“" + clip(b.text, 100) + "”";
		case "text":
			return clip(b.text, 120);
		case "thinking": {
			const tok = estTokens(b.text);
			const gist = firstLine(b.text, 80);
			return `thought · ~${tok} tok${gist ? " · " + gist : ""}`;
		}
		case "tool_call":
			// Tiny and durable — the digest is nearly the whole thing on purpose.
			return `${b.toolName ?? "tool"}(${clip(b.text.replace(/^\S+\s*/, ""), 70)})`;
		case "tool_result": {
			const name = b.toolName ?? "result";
			if (!b.text.trim()) return `${name} → ${b.isError ? "error" : "empty"}`;
			const lines = b.text.split("\n").filter((l) => l.trim()).length;
			const tag = b.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = firstLine(b.text, 60);
			return `${name} → ${tag}, ~${b.tokens} tok${peek ? " · " + peek : ""}`;
		}
		default:
			return clip(b.text, 80); // defensive: an unmodelled kind still gets a sane digest
	}
}

export function digestTokens(b: Block): number {
	const cached = digestTokenCache.get(b);
	if (cached !== undefined) return cached;
	const out = estTokens(digest(b)) + BLOCK_OVERHEAD;
	digestTokenCache.set(b, out);
	return out;
}

/**
 * Token cost of a strategy's substituted content (ADR 0007 — `Block.subst`). Unlike
 * `digest()` this is arbitrary, mutable text the strategy chose, so it is NOT cached on
 * the block (the same id may carry different substitutions over a session). Same
 * estimate + per-block overhead as a digest so accounting is apples-to-apples. (An empty
 * "" replace never reaches here — the `replace` op folds it to the engine digest instead.)
 */
export function substTokens(content: string): number {
	return estTokens(content) + BLOCK_OVERHEAD;
}

// ── multiblock folds (ADR 0006) ──────────────────────────────────────────────
// A GROUP collapses a contiguous run of blocks into ONE entry. Its summary is the
// single source of truth for both what the GUI's parent tile renders and what the
// agent receives in place of the range. Like a per-block digest it carries a leading
// `{#<code> FOLDED}` tag, where the code is `foldCode(group.id)` — ONE handle for the
// whole group, so `unfold({codes:[code]})` restores the entire range (ADR 0006 §6).

/** Order kinds appear in a group recap, with singular/plural nouns. */
const GROUP_KIND_NOUN: Record<BlockKind, [string, string]> = {
	// `system` can never actually appear in a group (`Truth.opGroup` refuses any snapped range that
	// contains a bolted block, whole, with `"bolted"`), but the map is `Record<BlockKind, …>` so the
	// entry has to exist. Kept honest rather than a placeholder in case the invariant is ever probed.
	system: ["system prompt", "system prompts"],
	user: ["ask", "asks"],
	text: ["reply", "replies"],
	thinking: ["thought", "thoughts"],
	tool_call: ["call", "calls"],
	tool_result: ["result", "results"],
};
const GROUP_KIND_ORDER: BlockKind[] = ["tool_result", "thinking", "text", "tool_call", "user", "system"];

/** Compact "turn 3" / "turns 3–5" / "preamble" label for a group's span. */
function turnSpan(members: Block[]): string {
	let lo = Infinity;
	let hi = -Infinity;
	for (const b of members) {
		if (b.turn < lo) lo = b.turn;
		if (b.turn > hi) hi = b.turn;
	}
	if (!isFinite(lo)) return "";
	const name = (t: number) => (t > 0 ? `turn ${t}` : "preamble");
	if (lo === hi) return name(lo);
	return lo > 0 ? `turns ${lo}–${hi}` : `preamble–turn ${hi}`;
}

/**
 * The deterministic recap a folded group collapses to (ADR 0006 §4 — "rules now, LLM
 * later"). Pure function of the group id + its member blocks; folding never changes it.
 * Always names that a user instruction is inside (a group may legally summarize a `user`
 * turn), so the agent is never silently deprived of the human's ask. `members` must be the
 * group's blocks in conversation order.
 */
export function groupDigest(group: Group, members: Block[]): string {
	const tag = foldTag(group.id);
	if (!members.length) return `${tag} group · empty`;
	const counts = new Map<BlockKind, number>();
	let tokens = 0;
	let ask = "";
	for (const b of members) {
		counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
		tokens += b.tokens;
		if (b.kind === "user" && !ask) ask = firstLine(b.text, 70);
	}
	const breakdown = GROUP_KIND_ORDER.filter((k) => counts.get(k))
		.map((k) => {
			const n = counts.get(k)!;
			const [one, many] = GROUP_KIND_NOUN[k];
			return `${n} ${n === 1 ? one : many}`;
		})
		.join(", ");
	const span = turnSpan(members);
	const head = `${tag} group · ${members.length} block${members.length === 1 ? "" : "s"}${span ? " · " + span : ""} · ~${tokens} tok`;
	const body = breakdown ? ` · ${breakdown}` : "";
	const quote = ask ? ` · “${ask}”` : "";
	return head + body + quote;
}

export function groupDigestTokens(group: Group, members: Block[]): number {
	return estTokens(groupDigest(group, members)) + BLOCK_OVERHEAD;
}

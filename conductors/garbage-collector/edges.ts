/*
 * edges.ts — the reference graph for the Garbage-collector conductor
 * (conductor-imaginarium.md, architecture #3 — "The Garbage Collector").
 *
 * The conductor's job is mark-and-sweep: a block is eligible to fold when it is
 * UNREACHABLE from anything live. "Live" = the roots (protected tail + human-held
 * blocks + the original task statement). "Reachable" = connected to a root through
 * the reference graph built here. This module owns that graph.
 *
 * Three kinds of edges, all bidirectional, all derived from the pure `ConductorView`:
 *
 *   1. CAUSAL — `tool_call` ↔ `tool_result` sharing a `callId`. The host already
 *      refuses to fold a `tool_call` (folding it would orphan its result), so this
 *      edge's job is to keep a result reachable while its call is live, and to let a
 *      call in the tail pull its (foldable) result partner back into reachability.
 *
 *   2. MESSAGE — assistant parts sharing an id prefix before `:` (`m<i>`). An
 *      assistant message's thinking / text / tool_call are one reasoning unit; if any
 *      part is live, the rest stay reachable. (Parse-level detail: the engine encodes
 *      message location in the id; see `live/mapping.ts` / `engine/parse.ts`.)
 *
 *   3. ENTITY — blocks whose text shares a distinctive identifier (file path, symbol,
 *      quoted string). This is the relevance signal: an old `tool_result` that read
 *      `parse.ts` and a protected-tail block that mentions `parse.ts` are linked, so
 *      the old lookup stays warm while the agent still works on that file. Identifier
 *      extraction is single-sourced: we reuse cold-score's `extractIdentifiers`
 *      (`conductors/cold-score/lexical.ts`) so the two relevance-aware conductors
 *      agree on what counts as a "symbol." (Hoisting that extractor into a shared
 *      `conductors/shared/` or the contract is a natural follow-up — see ADR 0012.)
 *
 * The entity edge is RARITY-GUARDED (mirrors cold-score's `matchBlocks`): an
 * identifier that appears in too many blocks is non-specific (a common token, not a
 * signal) and creates no edges. Members of a kept identifier group are linked as a
 * CHAIN, not a clique — reachability through a chain is equivalent to through a clique
 * for the mark phase, and chaining keeps the edge count linear per identifier.
 *
 * Pure, dependency-free, Node-safe — types only from `../contract`, plus the
 * shared, dependency-free `extractIdentifiers`. No Svelte, no `$state`, no engine
 * reach-in.
 */
import type { ViewBlock } from "../contract";
import { extractIdentifiers } from "../cold-score/lexical";

/** The reference graph: block id → set of neighbor block ids. */
export interface RefGraph {
	adj: Map<string, Set<string>>;
}

/**
 * The id prefix before `:` — the message index (`m<i>`). Assistant parts share it,
 * which is the parse-level signal that they belong to one reasoning unit. Blocks
 * without a `:` (defensive — the engine always emits one) degenerate to their whole id.
 */
function messagePrefix(id: string): string {
	const i = id.indexOf(":");
	return i < 0 ? id : id.slice(0, i);
}

/**
 * Build the reference graph over every block: causal (callId) + message (id-prefix)
 * + entity (shared identifier) edges, all bidirectional. Self-loops are never added.
 *
 * `blocks` is taken in conversation order but order does not affect the graph.
 */
export function buildGraph(blocks: ViewBlock[]): RefGraph {
	const adj = new Map<string, Set<string>>();
	for (const b of blocks) adj.set(b.id, new Set<string>());

	/** Add a bidirectional edge, ignoring self-loops and unknown ids. */
	const link = (a: string, b: string): void => {
		if (a === b) return;
		adj.get(a)?.add(b);
		adj.get(b)?.add(a);
	};

	// 1. CAUSAL — group by callId, chain members of each group.
	const byCallId = new Map<string, string[]>();
	for (const b of blocks) {
		if (!b.callId) continue;
		const arr = byCallId.get(b.callId);
		if (arr) arr.push(b.id);
		else byCallId.set(b.callId, [b.id]);
	}
	for (const ids of byCallId.values()) {
		for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);
	}

	// 2. MESSAGE — group by id prefix, chain members of each group.
	const byPrefix = new Map<string, string[]>();
	for (const b of blocks) {
		const p = messagePrefix(b.id);
		const arr = byPrefix.get(p);
		if (arr) arr.push(b.id);
		else byPrefix.set(p, [b.id]);
	}
	for (const ids of byPrefix.values()) {
		for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);
	}

	// 3. ENTITY — inverted index identifier → block ids; link (as a chain) the members
	//    of each RARITY-KEPT group. Mirrors cold-score's `matchBlocks` threshold: an
	//    identifier matching more than max(3, 25% of blocks) is too common to be a signal.
	const threshold = Math.max(3, Math.floor(blocks.length * 0.25));
	const idToBlocks = new Map<string, string[]>();
	for (const b of blocks) {
		if (b.text === undefined) continue; // wire-shape view without full text → no entity edges
		for (const id of extractIdentifiers(b.text)) {
			const arr = idToBlocks.get(id);
			if (arr) arr.push(b.id);
			else idToBlocks.set(id, [b.id]);
		}
	}
	for (const ids of idToBlocks.values()) {
		if (ids.length <= 1 || ids.length > threshold) continue; // singleton or non-specific
		for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);
	}

	return { adj };
}

/**
 * Mark every block reachable from `roots` through `graph` (mark phase of
 * mark-and-sweep). Returns the set of reachable block ids. Iterative DFS — no
 * recursion, so a long chain can't overflow the stack on a big session.
 */
export function markReachable(graph: RefGraph, roots: Iterable<string>): Set<string> {
	const marked = new Set<string>();
	const stack: string[] = [];
	for (const r of roots) stack.push(r);
	while (stack.length) {
		const id = stack.pop()!;
		if (marked.has(id)) continue;
		marked.add(id);
		const neigh = graph.adj.get(id);
		if (neigh) for (const n of neigh) if (!marked.has(n)) stack.push(n);
	}
	return marked;
}

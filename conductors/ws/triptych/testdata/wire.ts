/*
 * wire.ts — the message ↔ block bridge for the live pi link (was live/mapping.ts).
 *
 * SHARED by the GUI and the pi extension, so the provider-safety rules live in exactly
 * one place. Pure + framework-free — part of `core/`.
 *
 *   linearize(messages) → WireBlock[]   (pi's in-memory messages → our blocks)
 *   applyPlan(messages, ops) → messages (fold a block in place, provider-safely)
 *
 * Block ids are durable and content-anchored — identical whether derived now or
 * after the message array shifts position:
 *   • user          → `u:<timestamp>`
 *   • assistant part j (thinking/text/tool_call) → `a:<responseId ?? "t"+timestamp>:p<j>`
 *   • tool_result   → `r:<toolCallId>`
 *   • summary/other → `s:<timestamp>`
 * Fallback (missing anchor): `m<i>:u`, `m<i>:p<j>`, `m<i>:r`, `m<i>:s` (position-based,
 * same as the old scheme) — so nothing crashes on malformed messages.
 *
 * NOTE ON THE PROTOCOL IMPORT: `WireBlock`/`FoldOp`/`GroupOp` are wire-message shapes that now
 * live in `core/protocol.ts` (relocated in Phase B; `app/src/lib/live/protocol.ts` is a re-export
 * shim). We import them TYPE-ONLY, so the reference is erased at compile time.
 */
import type { WireBlock, FoldOp, GroupOp } from "./protocol";
import type { Block } from "./types";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";
import { foldTag } from "./digest";

// ── Minimal structural types for pi's in-memory AgentMessage ─────────────────
// (We only model the fields we read; pi owns the real types.)
export interface PiTextPart {
	type: "text";
	text: string;
}
export interface PiThinkingPart {
	type: "thinking";
	thinking: string;
}
export interface PiToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}
export type PiPart = PiTextPart | PiThinkingPart | PiToolCallPart | { type: string; [k: string]: unknown };

export interface PiMessage {
	role: string;
	content?: string | PiPart[] | Array<{ type: string; text?: string }>;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	summary?: string;
	/** Set once at message creation; the primary anchor for user/summary/assistant fallback ids. */
	timestamp?: number;
	/** Provider-assigned response id; preferred anchor for assistant-message part ids. */
	responseId?: string;
}

/**
 * Compute a durable, content-anchored block id that is IDENTICAL regardless of
 * where the message sits in the array. Both `linearize` and `applyPlan` must call
 * this — never inline the formula — so the two can never drift.
 *
 * @param m         the pi message
 * @param i         the message's current array index (used ONLY as a fallback)
 * @param partIndex for assistant messages, the content-part index; omit for others
 */
export function blockId(m: PiMessage, i: number, partIndex?: number): string {
	switch (m.role) {
		case "user":
			return m.timestamp != null ? `u:${m.timestamp}` : `m${i}:u`;
		case "assistant": {
			if (partIndex == null) return `m${i}:p?`; // shouldn't happen; defensive only
			const anchor = m.responseId != null ? m.responseId : m.timestamp != null ? `t${m.timestamp}` : null;
			return anchor != null ? `a:${anchor}:p${partIndex}` : `m${i}:p${partIndex}`;
		}
		case "toolResult":
			return m.toolCallId != null ? `r:${m.toolCallId}` : `m${i}:r`;
		default:
			return m.timestamp != null ? `s:${m.timestamp}` : `m${i}:s`;
	}
}

/**
 * Is `id` a durable, content-anchored block id (vs. a positional fallback)?
 *
 * `blockId()` prefers a durable anchor (`u:`, `a:`, `r:`, `s:` — keyed off the
 * message timestamp / responseId / toolCallId), and only falls back to a
 * POSITIONAL id (`m<i>:…`) when that anchor is missing. The distinction matters
 * for folding: a positional id encodes the message's *current array index*, and
 * that index is NOT stable once the array shifts. Folding itself makes the
 * context non-append-only (a later structural change can renumber positions), so
 * a positional id can silently come to point at a DIFFERENT block. We therefore
 * must never emit a fold op for a block we can't durably re-identify — otherwise
 * applyPlan could fold the wrong part (or, worse, a tool_call). This guard is the
 * gate: fold only durable ids.
 *
 * Kept in lockstep with the formats `blockId()` produces above.
 */
export function isDurableId(id: string): boolean {
	return id.startsWith("u:") || id.startsWith("a:") || id.startsWith("r:") || id.startsWith("s:");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b): b is { type: string; text: string } => !!b && (b as any).type === "text" && typeof (b as any).text === "string")
			.map((b) => b.text)
			.join("\n");
	return "";
}

const tokensFor = (text: string): number => estTokens(text) + BLOCK_OVERHEAD;

/**
 * Linearize pi's in-memory message array into wire blocks, mirroring the on-disk
 * parser (engine/parse.ts → parsePi) but operating on live messages. Deterministic:
 * same messages → same blocks/ids.
 *
 * `orderStart` / `turnStart` let a caller linearize a SUFFIX with globally-correct numbering
 * (Phase B incremental append): pass the count of blocks already appended as `orderStart` and the
 * current turn number as `turnStart`, so the suffix's `order` continues contiguously and its `turn`
 * continues from the last block's turn (a leading user message advances to `turnStart + 1`). Both
 * default to 0 — a full linearize is unchanged.
 */
export function linearize(messages: PiMessage[], orderStart = 0, turnStart = 0): WireBlock[] {
	const out: WireBlock[] = [];
	let order = orderStart;
	let turn = turnStart;

	const push = (
		id: string,
		kind: WireBlock["kind"],
		text: string,
		extra: Partial<Pick<WireBlock, "toolName" | "callId" | "model" | "isError">> = {},
	) => {
		if (!text && kind !== "tool_result") return; // drop empty non-results (parity with parse.ts)
		out.push({ id, kind, turn, order: order++, text, tokens: tokensFor(text), ...extra });
	};

	messages.forEach((m, i) => {
		switch (m.role) {
			case "user": {
				turn += 1;
				push(blockId(m, i), "user", textOf(m.content));
				break;
			}
			case "assistant": {
				const parts = Array.isArray(m.content) ? (m.content as PiPart[]) : [];
				parts.forEach((b, j) => {
					if (b?.type === "thinking") push(blockId(m, i, j), "thinking", (b as PiThinkingPart).thinking || "", { model: m.model });
					else if (b?.type === "text") push(blockId(m, i, j), "text", (b as PiTextPart).text || "", { model: m.model });
					else if (b?.type === "toolCall") {
						const c = b as PiToolCallPart;
						push(blockId(m, i, j), "tool_call", `${c.name} ${JSON.stringify(c.arguments ?? {})}`, {
							toolName: c.name,
							callId: c.id,
							model: m.model,
						});
					}
				});
				break;
			}
			case "toolResult": {
				push(blockId(m, i), "tool_result", textOf(m.content), {
					toolName: m.toolName || "tool",
					callId: m.toolCallId,
					isError: !!m.isError,
				});
				break;
			}
			default: {
				// bash / custom / branchSummary / compactionSummary — surface any summary text
				if (typeof m.summary === "string" && m.summary) push(blockId(m, i), "text", m.summary);
			}
		}
	});

	return out;
}

/** Convert a wire block back into a full engine Block (fresh, auto-controlled). */
export function wireToBlock(w: WireBlock): Block {
	return {
		id: w.id,
		kind: w.kind,
		turn: w.turn,
		order: w.order,
		text: w.text,
		tokens: w.tokens,
		toolName: w.toolName,
		callId: w.callId,
		model: w.model,
		isError: w.isError,
		override: null,
		autoFolded: false,
		by: null,
	};
}

/** The durable block ids a single message emits + its tool-pair callIds (mirrors `linearize`). */
export interface MsgInfo {
	ids: string[];
	calls: string[]; // callIds of this message's tool_call parts
	results: string[]; // callId of this message, if it is a tool_result
	hasNonDurable: boolean; // any emitted id is positional → message is never group-removable
}

/**
 * The durable ids + tool-pair callIds one message contributes (mirror of `linearize`). Exported
 * from `core/` so the Truth core's group-classification can reuse the exact wire semantics
 * rather than re-deriving them.
 */
export function messageInfo(m: PiMessage, i: number): MsgInfo {
	const ids: string[] = [];
	const calls: string[] = [];
	const results: string[] = [];
	let hasNonDurable = false;
	const push = (id: string) => {
		ids.push(id);
		if (!isDurableId(id)) hasNonDurable = true;
	};
	switch (m.role) {
		case "user":
			push(blockId(m, i));
			break;
		case "assistant": {
			const parts = Array.isArray(m.content) ? (m.content as PiPart[]) : [];
			parts.forEach((b, j) => {
				// Mirror linearize: empty non-result parts are not emitted, so they are not members.
				if (b?.type === "thinking") {
					if ((b as PiThinkingPart).thinking) push(blockId(m, i, j));
				} else if (b?.type === "text") {
					if ((b as PiTextPart).text) push(blockId(m, i, j));
				} else if (b?.type === "toolCall") {
					push(blockId(m, i, j));
					const id = (b as PiToolCallPart).id;
					if (id) calls.push(id);
				}
			});
			break;
		}
		case "toolResult":
			push(blockId(m, i));
			if (m.toolCallId) results.push(m.toolCallId);
			break;
		default:
			if (typeof m.summary === "string" && m.summary) push(blockId(m, i));
	}
	return { ids, calls, results, hasNonDurable };
}

// ── content fingerprint (E1 reconciliation, sol P1 hardening) ────────────────
//
// `messageInfo` proves SHAPE identity (which durable blocks a message emits, in what order).
// `contentFingerprint` is its sibling: it proves CONTENT identity (did any block's payload change
// under a stable anchor). The extension's per-hook reconcile compares BOTH — same shape + same
// fingerprint ⇒ append-a-suffix; either differs ⇒ divergence rebuild. Lives here, dependency-free,
// next to `messageInfo` so the wire semantics it mirrors stay in one place.

/**
 * FNV-1a 32-bit rolling hash primitives (no deps, deterministic, non-crypto). Each 16-bit code unit
 * is folded LOW byte then HIGH byte so the hash depends on the full unit — a same-low-byte non-ASCII
 * swap (e.g. U+3042 vs U+3142) still moves the hash. `Math.imul` keeps every step in 32-bit; callers
 * finish with `h >>> 0` for an unsigned result.
 */
const FNV_PRIME = 0x01000193;
function fnvStr(h: number, s: string): number {
	for (let k = 0; k < s.length; k++) {
		const c = s.charCodeAt(k);
		h = Math.imul(h ^ (c & 0xff), FNV_PRIME);
		h = Math.imul(h ^ (c >>> 8), FNV_PRIME);
	}
	return h;
}
function fnvByte(h: number, b: number): number {
	return Math.imul(h ^ (b & 0xff), FNV_PRIME);
}
function fnvContent(h: number, content: unknown): number {
	if (typeof content === "string") return fnvStr(h, content);
	if (Array.isArray(content))
		for (const p of content) {
			const t = (p as { text?: unknown } | null)?.text;
			if (typeof t === "string") h = fnvStr(h, t);
		}
	return h;
}

/**
 * Real CONTENT fingerprint for one message — the counterpart to `messageInfo`'s durable ids, compared
 * alongside them by the extension's `sameMessageIdentity` (E1, external review round; hardened per sol
 * P1). Durable ids alone prove only the SHAPE (which blocks exist, in what order) is unchanged — they
 * say nothing about whether pi or a peer extension rewrote a block's payload IN PLACE while keeping the
 * same anchor (same timestamp / responseId / toolCallId). Without this, `Truth.append`'s id-based
 * idempotency keeps the OLD payload forever: the GUI, `recall`, and a folded block's wire digest all
 * silently keep serving stale content even though the model itself now sees something new — and a stale
 * strategy subst could put the old text back on the wire.
 *
 * WHAT IT COVERS (every mutable field `linearize`/`wireToBlock` bake into a Block that the durable id
 * does NOT already pin — i.e. everything a same-id rewrite could flip):
 *   • text / thinking / user / tool_result / summary TEXT;
 *   • tool_call `name` + serialized `arguments` (sol P1 gap #2 — a same-id argument rewrite was
 *     previously invisible; serialized with the SAME `JSON.stringify(arguments ?? {})` `linearize`
 *     uses to build the block text, so the two agree). Assumes pi's per-hook deep copy preserves key
 *     order for an UNCHANGED message, so a stable arguments object re-serializes identically; if it
 *     ever did not, the only cost is a spurious rebuild (safe — never a MISSED change);
 *   • tool_result `isError` (gap #3 — a success→error flip with identical text kept a stale flag that
 *     the doorman conductor then classified from) and `toolName`; assistant `model`.
 * A per-field tag byte separates parts so "text 'ab'" ≠ "text 'a' + thinking 'b'".
 *
 * COST (the ADR 0021 hot-path promise: the `context` hook stays local + fast). This is O(chars in the
 * message) — a real pass over the text, unlike the length-sum it replaces. The extension CACHES each
 * message's fingerprint at ingest, so a hook re-hashes only the fresh INCOMING copy pi hands it (object
 * identity never survives the deep copy). Measured on the ~130k-token dev sample
 * (`app/static/sample-session.jsonl`, ~585KB of text): a full two-byte FNV pass over the WHOLE context
 * is ~3.2ms — comfortably under the ~10ms budget at which a sampled/strided hybrid would be needed, and
 * well under the LATENCY badge's 250ms amber. Full fidelity is worth it for the redaction cases here.
 *
 * RESIDUAL GAP: a same-length in-place rewrite (fixed-width redaction) is NO LONGER an accepted gap —
 * it now moves the hash and forces a rebuild. What remains is the FNV-1a 32-bit collision floor: two
 * genuinely different messages hash-collide with probability ~2^-32, in which case a real rewrite would
 * be missed. Accepted over a crypto hash (orders of magnitude slower on this hot path) for a vanishingly
 * rare, non-adversarial-by-construction event — a peer extension is first-party; no attacker is choosing
 * colliding rewrites.
 */
export function contentFingerprint(m: PiMessage): number {
	let h = 0x811c9dc5; // FNV offset basis
	switch (m.role) {
		case "user":
			h = fnvByte(h, 1);
			h = fnvContent(h, m.content);
			break;
		case "assistant": {
			h = fnvByte(h, 2);
			if (typeof m.model === "string") h = fnvStr(h, m.model);
			const parts = Array.isArray(m.content) ? (m.content as PiPart[]) : [];
			for (const b of parts) {
				if (b?.type === "text") {
					h = fnvByte(h, 0x10);
					h = fnvStr(h, (b as PiTextPart).text || "");
				} else if (b?.type === "thinking") {
					h = fnvByte(h, 0x11);
					h = fnvStr(h, (b as PiThinkingPart).thinking || "");
				} else if (b?.type === "toolCall") {
					const c = b as PiToolCallPart;
					h = fnvByte(h, 0x12);
					h = fnvStr(h, c.name || "");
					h = fnvStr(h, JSON.stringify(c.arguments ?? {})); // args covered — sol P1 gap #2
				}
			}
			break;
		}
		case "toolResult":
			h = fnvByte(h, 3);
			h = fnvByte(h, m.isError ? 1 : 0); // metadata covered — sol P1 gap #3
			if (typeof m.toolName === "string") h = fnvStr(h, m.toolName);
			h = fnvContent(h, m.content);
			break;
		default:
			h = fnvByte(h, 4);
			if (typeof m.summary === "string") h = fnvStr(h, m.summary);
	}
	return h >>> 0;
}

/**
 * One logical wire message's role + tool-pairing shape (`MsgInfo` plus its wire `role`) — the
 * exact fields the role-validity floor and Phase A ownership cascade need, abstracted away from
 * the concrete representation so BOTH `applyPlan` (real `PiMessage[]`) and `Truth`'s group-token
 * accounting (which only ever holds `Block`s — the GUI/replica never sees pi's live messages) can
 * build the identical input and land on the identical verdict.
 *
 * `role` is the message's RAW role string (e.g. `"user" | "assistant" | "toolResult" | …`) —
 * deliberately NOT pre-collapsed to just assistant/non-assistant, because the floor below only
 * does that collapsing at specific points (a synthesized survivor's role vs. a genuine survivor's
 * own role); a caller that pre-collapsed everything would silently change which messages compare
 * equal and could mask a real same-role adjacency.
 */
export interface WireMsgShape extends MsgInfo {
	role: string;
}

/**
 * The role-validity floor's decision, extracted to ONE function so `applyPlan` and `Truth`'s
 * group-token accounting can never drift apart. Drift here is not cosmetic: it would mean the
 * UI's claimed savings lies about what the model actually receives — the one thing this repo
 * promises never happens (CLAUDE.md). Two things come out:
 *
 *   • `owner` — Phase A's message→group cascade (a message may be removed by at most ONE group,
 *     and only if every tool-call/tool_result pair it holds is fully inside the removal set — see
 *     the fixpoint below). `applyPlan`'s Phase B needs this to know which messages one group's
 *     run spans; `Truth` does not (it already has each group's own `memberIds`), so it only reads
 *     `degradeStart`.
 *   • `degradeStart` — indices (into `msgs`) of a PURE DROP run (`summaryText === null`) whose
 *     removal would leave the surviving wire structurally invalid (a non-"user" leading message,
 *     or two adjacent same-role survivors) and must therefore synthesize a one-message recap
 *     instead of vanishing (see `applyPlan`'s doc comment for the full rationale).
 *
 * Pure function of `msgs`/`groups` — no I/O, no randomness: same shapes in, same verdict out,
 * on the host AND on a replica that reconstructs `msgs` from its own `Block`s (see
 * `Truth.degradedRunKeys`).
 */
export function computeDegradedDropRuns(
	msgs: readonly WireMsgShape[],
	groups: readonly GroupOp[],
): { owner: (GroupOp | null)[]; degradeStart: Set<number> } {
	const owner: (GroupOp | null)[] = new Array(msgs.length).fill(null);
	const degradeStart = new Set<number>();
	if (!groups.length) return { owner, degradeStart };

	const memberToGroup = new Map<string, GroupOp>();
	for (const g of groups) for (const id of g.memberIds) if (isDurableId(id)) memberToGroup.set(id, g);
	// Initial: a message all of whose emitted ids are durable and members of ONE group.
	for (let i = 0; i < msgs.length; i++) {
		const info = msgs[i];
		if (!info.ids.length || info.hasNonDurable) continue;
		let g: GroupOp | null = null;
		let ok = true;
		for (const id of info.ids) {
			const gg = memberToGroup.get(id);
			if (!gg || (g && gg !== g)) {
				ok = false;
				break;
			}
			g = gg;
		}
		if (ok && g) owner[i] = g;
	}
	// Fixpoint: keep a removal only if its tool pairs are fully inside the removal set.
	for (let changedSet = true; changedSet; ) {
		changedSet = false;
		const calls = new Set<string>();
		const results = new Set<string>();
		for (let i = 0; i < msgs.length; i++) {
			if (!owner[i]) continue;
			for (const c of msgs[i].calls) calls.add(c);
			for (const c of msgs[i].results) results.add(c);
		}
		for (let i = 0; i < msgs.length; i++) {
			if (!owner[i]) continue;
			const info = msgs[i];
			if (info.calls.some((c) => !results.has(c)) || info.results.some((c) => !calls.has(c))) {
				owner[i] = null; // straggler: a tool-pair half is outside → keep this message live
				changedSet = true;
			}
		}
	}

	// ── Role-validity floor ── re-scan left to right until stable: an EARLIER run's verdict can
	// depend on whether a LATER run also degrades (a degraded run survives as a synthesized
	// message, changing what "the next survivor's role" is for anything peeking past it), so one
	// pass is not always enough. `degradeStart` only ever grows, so this always terminates.
	for (let stable = false; !stable; ) {
		stable = true;
		let prevRole: string | undefined; // role of the closest survivor seen so far (undefined = wire start)
		let i = 0;
		while (i < msgs.length) {
			const g = owner[i];
			if (!g) {
				prevRole = msgs[i].role;
				i++;
				continue;
			}
			let j = i + 1;
			while (j < msgs.length && owner[j] === g) j++;
			const pureDrop = g.summaryText === null && !degradeStart.has(i);
			if (!pureDrop) {
				// A REPLACE run, or a drop already degraded on a prior pass — both survive as
				// one synthesized message (mirrors Phase B's role mapping exactly).
				prevRole = msgs[i].role === "assistant" ? "assistant" : "user";
				i = j;
				continue;
			}
			// Still a pure-drop candidate: peek the next SURVIVING role, skipping over any
			// further pure-drop runs (from this or another group) so cascaded drops resolve
			// against whatever actually ends up adjacent.
			let k = j;
			let nextRole: string | undefined;
			while (k < msgs.length) {
				const g2 = owner[k];
				if (!g2) {
					nextRole = msgs[k].role;
					break;
				}
				let kj = k + 1;
				while (kj < msgs.length && owner[kj] === g2) kj++;
				if (g2.summaryText === null && !degradeStart.has(k)) {
					k = kj; // another pure drop — keep looking past it
					continue;
				}
				nextRole = msgs[k].role === "assistant" ? "assistant" : "user";
				break;
			}
			const leadingProblem = prevRole === undefined && nextRole !== undefined && nextRole !== "user";
			const adjacencyProblem = prevRole !== undefined && prevRole === nextRole;
			if (leadingProblem || adjacencyProblem) {
				degradeStart.add(i);
				stable = false;
				// The degraded run now survives as one synthesized recap, so later runs on THIS
				// pass must resolve against ITS role — leaving the stale pre-degrade survivor role
				// here made a cascade of adjacent drop runs over-degrade, welding the second recap
				// against the next survivor: the exact same-role adjacency this floor exists to
				// prevent (repro: two drop groups splitting a tool_call/tool_result turn between
				// two user survivors).
				prevRole = msgs[i].role === "assistant" ? "assistant" : "user";
			}
			// else: the run truly vanishes — it emits nothing, so the closest-survivor role is
			// UNCHANGED. (Nulling it treated mid-wire positions as wire-start, misfiring the
			// leading check and disabling the adjacency check for the following run.)
			i = j;
		}
	}
	return { owner, degradeStart };
}

/** Apply one message's in-place FoldOps (the original substitution path). Returns the same
 *  message by reference when nothing folds; clones lazily otherwise. `mark()` flags a change.
 *  An op whose id matches a `tool_call` part (or any non-text/thinking kind) is deliberately
 *  never applied — substituting it would orphan its result. The wire trusts the engine's plan:
 *  the engine is the single foldability gate and it never folds a protected block, so no
 *  separate wire-side position protection is needed here. The durable-id + structural guards
 *  (kind checks, non-empty digest) remain the safety floor. */
function foldOne(m: PiMessage, i: number, byId: Map<string, FoldOp>, mark: () => void): PiMessage {
	if (m.role === "assistant" && Array.isArray(m.content)) {
		let parts: PiPart[] | null = null; // lazily cloned only if we actually fold
		(m.content as PiPart[]).forEach((b, j) => {
			const id = blockId(m, i, j);
			const op = byId.get(id);
			if (!op || !op.digestText) return;
			if (b?.type === "text") {
				parts ??= (m.content as PiPart[]).slice();
				parts[j] = { ...(b as PiTextPart), text: op.digestText };
			} else if (b?.type === "thinking") {
				parts ??= (m.content as PiPart[]).slice();
				parts[j] = { ...(b as PiThinkingPart), thinking: op.digestText };
			}
			// tool_call or any other kind → ignored (never fold / id mis-map)
		});
		if (parts) {
			mark();
			return { ...m, content: parts };
		}
		return m;
	}
	if (m.role === "toolResult") {
		const id = blockId(m, i);
		const op = byId.get(id);
		if (op && op.digestText) {
			mark();
			return { ...m, content: [{ type: "text", text: op.digestText }] };
		}
		return m;
	}
	return m; // user / other: never folded
}

/**
 * Apply a fold plan to pi's messages and return a NEW array (touched messages are
 * cloned; untouched ones are passed through by reference). Pure: the caller's array
 * is never mutated, so correctness never depends on pi's copy semantics.
 *
 * Two kinds of op:
 *
 *   • `FoldOp` — IN-PLACE content substitution (ADR 0001–0005), each defended by a kind
 *     check so a mis-mapped id can never fold the wrong part:
 *       tool_result → one text part (keep toolCallId/toolName/isError) · text/thinking →
 *       the (non-empty) digest · tool_call → NEVER (orphans its result) · user/other → NEVER.
 *
 *   • `GroupOp` — RANGE COLLAPSE (ADR 0006): remove a contiguous run of WHOLE messages and
 *     insert ONE synthetic summary message. The ONLY op that changes the message count.
 *     Two independent guards, re-derived here (never trusting the GUI):
 *       1. whole + durable — a message is removable only if EVERY block it emits is durable
 *          and a member of one group (a partially-covered or positional-id message stays);
 *       2. balanced pairs — a removed tool_call must have its tool_result removed too, to a
 *          fixpoint; an unbalanced message is demoted to stay-live (the straggler).
 *     The wire trusts the engine's plan: the engine is the single foldability gate and never
 *     folds a protected block, so no separate wire-side position backstop is needed.
 *     Each maximal run of same-group removable messages becomes one message (role = the
 *     run's first message's role, mapped to user/assistant; content = the summary text) —
 *     UNLESS `summaryText === null` (DROP: consume the run, push nothing), subject to the
 *     role-validity floor immediately below.
 *
 * ── Role-validity floor (P3, review-confirmed; ADR 0006 named this as an open watch item) ──
 * A DROP run pushes NOTHING onto the wire, so it can silently build a message array a provider
 * rejects: (a) if the run sits at the very front of the surviving wire, the first message left
 * may not be `role: "user"` (Anthropic requires `messages[0].role === "user"`); (b) if it sits
 * between two survivors of the SAME role, removing it welds them into an adjacent same-role
 * pair (`user_k` directly followed by `user_k+1`) that some providers reject or mis-merge. This
 * floor is unconditional: it runs for every caller (conductor, GUI command, replica), not just
 * Thermocline's stratum drops — the same shape a raw GUI command can send.
 *
 * The repair DEGRADES the offending run from a true drop to a one-message recap — the same
 * shape as the `summary: undefined` default-recap (the `Group.digest` three-state contract:
 * undefined → recap, null/"" → drop, string → verbatim), just synthesized HERE instead of by
 * `Truth.groupSummary` (which needs `Block[]`; this function only has `PiMessage[]`). The
 * recap's role follows the exact mapping an ordinary REPLACE run already uses (`assistant` if
 * the run's first message was `assistant`, else `user`), and its tag is `foldTag(g.id)` — the
 * IDENTICAL code `resolveUnfold` already matches against `truth.groups` (a drop group is a
 * folded `Group` too), so an agent that unfolds this recap genuinely restores the group (Truth
 * flips `folded:false`; the next `serializeWire` stops dropping it) — no new plumbing needed.
 *
 * REJECTED ALTERNATIVE: refuse to drop just the run's boundary message (keep it live in place)
 * instead of synthesizing a recap. Simpler, but it cascades: if that boundary message holds one
 * half of a tool-call/tool_result pair whose OTHER half is deeper in the same run, keeping it
 * live orphans the pair, forcing the tool-pair fixpoint above to un-own the rest of the run too
 * — a small balanced-pair run can unwind to a complete no-op just to keep one message alive. The
 * recap avoids this: the WHOLE run (calls and results alike) is still removed exactly as Phase A
 * decided; only what Phase B EMITS in its place changes, so it can never re-open an orphan.
 *
 * ACCOUNTING (`core/truth.ts`): `Truth.groupLiveTokens` charges a DROP group's collapsed run(s)
 * per-RUN, not a single 0-for-everything shortcut, precisely BECAUSE this floor can degrade one
 * run of a group while its siblings still vanish for free. `Truth.degradedRunKeys` reconstructs
 * `WireMsgShape[]` from its own `Block` log and feeds the SAME `computeDegradedDropRuns` this
 * function calls below — the identical decision, not a re-derived approximation — so the GUI's
 * live-token readout matches what the model actually receives even for a degraded run.
 *
 * On ANY doubt a message passes through untouched; the output is never structurally invalid
 * (no orphaned tool pair, no emptied message, no role-invalid leading or adjacent message). Safe
 * because this output feeds the model only — the GUI's block sync/cursor run off the
 * un-collapsed `linearize`, so removals never desync the view (ADR 0006 §4).
 */
export function applyPlan(messages: PiMessage[], ops: FoldOp[], groups: GroupOp[] = []): PiMessage[] {
	// Defense in depth (matches the GUI's `computeFoldOps`/`computeGroupOps`): refuse any op
	// whose id is NOT durable or whose digest is empty, and any group with no summary/members.
	// This is the shared safety boundary on the path that feeds the real model, so it cannot
	// trust the peer's SHAPE, not just its values: a null op, a non-string id, or a non-string
	// member would otherwise throw inside the `context` hook (e.g. `isDurableId(null)`) and
	// defeat the passthrough guarantee. Re-derive every guard defensively and drop anything off.
	const safeOps = (ops ?? []).filter((o) => o && typeof o.id === "string" && isDurableId(o.id) && typeof o.digestText === "string" && o.digestText);
	// A group is valid if:
	//   • every member id is a string (non-string ids would throw inside isDurableId)
	//   • summaryText is null (drop group — valid) OR a non-empty, non-whitespace string
	//     (a whitespace-only string would emit a provider-invalid text part; empty string
	//     is not a drop op — it is a malformed non-drop op, so we reject it).
	const safeGroups = (groups ?? []).filter(
		(g) =>
			g &&
			Array.isArray(g.memberIds) &&
			g.memberIds.length &&
			g.memberIds.every((m) => typeof m === "string") &&
			(g.summaryText === null || (typeof g.summaryText === "string" && g.summaryText.trim())),
	);
	if (!safeOps.length && !safeGroups.length) return messages;

	const byId = new Map(safeOps.map((o) => [o.id, o] as const));

	// ── Phase A: decide which whole messages each group may remove, AND which resulting runs
	// the role-validity floor must degrade to a recap — both computed by ONE shared function so
	// `Truth`'s accounting can call the identical decision (see `computeDegradedDropRuns`'s doc
	// comment). Building `WireMsgShape[]` costs a `messageInfo` call per message, so it stays
	// gated behind `safeGroups.length` exactly like the inline computation it replaces.
	const { owner, degradeStart } = safeGroups.length
		? computeDegradedDropRuns(
				messages.map((m, i): WireMsgShape => ({ ...messageInfo(m, i), role: m.role })),
				safeGroups,
			)
		: { owner: new Array<GroupOp | null>(messages.length).fill(null), degradeStart: new Set<number>() };

	// ── Phase B: build the output — collapse runs, fold survivors in place ────────
	let changed = false;
	const mark = () => {
		changed = true;
	};
	const out: PiMessage[] = [];
	for (let i = 0; i < messages.length; ) {
		const g = owner[i];
		if (g) {
			// Consume the maximal consecutive run owned by the SAME group. A group split by
			// an interior straggler yields one entry per run (same group object, same decision).
			let j = i + 1;
			while (j < messages.length && owner[j] === g) j++;
			if (g.summaryText === null && !degradeStart.has(i)) {
				// DROP: consume the run and push nothing — the agent never sees these messages.
				changed = true;
			} else {
				// REPLACE (existing behavior), OR a DROP degraded by the role-validity floor:
				// insert ONE synthetic message so the wire never starts non-"user" or welds two
				// same-role survivors together.
				const role = messages[i].role === "assistant" ? "assistant" : "user";
				const text = g.summaryText !== null ? g.summaryText : roleFloorRecap(g.id, j - i);
				out.push({ role, content: [{ type: "text", text }] } as PiMessage);
				changed = true;
			}
			i = j;
			continue;
		}
		out.push(foldOne(messages[i], i, byId, mark));
		i++;
	}

	return changed ? out : messages;
}

/**
 * The role-validity floor's fallback recap for a DROP run it had to degrade (see `applyPlan`'s
 * doc comment). Same `{#code FOLDED}` tag convention as a real group summary, and the SAME code
 * (`foldTag(groupId)`) — so an agent `unfold` of it hits the real group via `resolveUnfold`'s
 * existing `foldCode(g.id) === code` match (a drop group is a folded `Group` too) and genuinely
 * restores it. No new recall/unfold plumbing needed; this just reuses the existing group path.
 *
 * Exported (not just used by `applyPlan`) so `Truth.groupLiveTokens` can estimate a degraded
 * run's REAL wire cost from the EXACT text the wire will emit, rather than duplicating this
 * string format and risking the two silently drifting apart. Takes a bare `groupId: string`
 * (not a whole `GroupOp`/`Group`) so either caller's own group shape works with no coupling.
 */
export function roleFloorRecap(groupId: string, runLength: number): string {
	return `${foldTag(groupId)} group · ${runLength} message${runLength === 1 ? "" : "s"} dropped (kept live as a stub for wire validity)`;
}

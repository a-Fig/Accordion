/*
 * mapping.ts — the message ↔ block bridge for the live pi link.
 *
 * SHARED by the GUI and the pi extension (imported from extension/accordion.ts),
 * so the provider-safety rules live in exactly one place. Pure + framework-free.
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
 */
import type { WireBlock, FoldOp, GroupOp } from "./protocol";
import type { Block } from "../engine/types";
import { estTokens, BLOCK_OVERHEAD } from "../engine/tokens";

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
 */
export function linearize(messages: PiMessage[]): WireBlock[] {
	const out: WireBlock[] = [];
	let order = 0;
	let turn = 0;

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
interface MsgInfo {
	ids: string[];
	calls: string[]; // callIds of this message's tool_call parts
	results: string[]; // callId of this message, if it is a tool_result
	hasNonDurable: boolean; // any emitted id is positional → message is never group-removable
}
function messageInfo(m: PiMessage, i: number): MsgInfo {
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

/** Apply one message's in-place FoldOps (the original substitution path). Returns the same
 *  message by reference when nothing folds; clones lazily otherwise. `mark()` flags a change.
 *  The wire trusts the engine's plan: the engine is the single foldability gate and it never
 *  folds a protected block, so no separate wire-side position protection is needed here.
 *  The durable-id + structural guards (kind checks, non-empty digest) remain the safety floor. */
function foldOne(m: PiMessage, i: number, byId: Map<string, FoldOp>, mark: () => void): PiMessage {
	if (m.role === "assistant" && Array.isArray(m.content)) {
		let parts: PiPart[] | null = null; // lazily cloned only if we actually fold
		(m.content as PiPart[]).forEach((b, j) => {
			const op = byId.get(blockId(m, i, j));
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
		const op = byId.get(blockId(m, i));
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
 *     run's first message's role, mapped to user/assistant; content = the summary text).
 *
 * On ANY doubt a message passes through untouched; the output is never structurally invalid
 * (no orphaned tool pair, no emptied message). Safe because this output feeds the model only
 * — the GUI's block sync/cursor run off the un-collapsed `linearize`, so removals never
 * desync the view (ADR 0006 §4).
 */
export function applyPlan(messages: PiMessage[], ops: FoldOp[], groups: GroupOp[] = []): PiMessage[] {
	// Defense in depth (matches the GUI's `computeFoldOps`/`computeGroupOps`): refuse any op
	// whose id is NOT durable or whose digest is empty, and any group with no summary/members.
	// This is the shared safety boundary on the path that feeds the real model, so it cannot
	// trust the peer's SHAPE, not just its values: a null op, a non-string id, or a non-string
	// member would otherwise throw inside the `context` hook (e.g. `isDurableId(null)`) and
	// defeat the passthrough guarantee. Re-derive every guard defensively and drop anything off.
	const safeOps = (ops ?? []).filter((o) => o && typeof o.id === "string" && isDurableId(o.id) && typeof o.digestText === "string" && o.digestText);
	// summaryText must be a NON-EMPTY string and every member id a string (a number/object/
	// whitespace value would emit a provider-invalid text part or throw downstream).
	const safeGroups = (groups ?? []).filter(
		(g) =>
			g &&
			typeof g.summaryText === "string" &&
			g.summaryText.trim() &&
			Array.isArray(g.memberIds) &&
			g.memberIds.length &&
			g.memberIds.every((m) => typeof m === "string"),
	);
	if (!safeOps.length && !safeGroups.length) return messages;

	const byId = new Map(safeOps.map((o) => [o.id, o] as const));

	// ── Phase A: decide which whole messages each group may remove ───────────────
	const owner: (GroupOp | null)[] = new Array(messages.length).fill(null);
	if (safeGroups.length) {
		const memberToGroup = new Map<string, GroupOp>();
		for (const g of safeGroups) for (const id of g.memberIds) if (isDurableId(id)) memberToGroup.set(id, g);
		const infos = messages.map((m, i) => messageInfo(m, i));
		// Initial: a message all of whose emitted ids are durable and members of ONE group.
		// The wire trusts the engine's plan (the engine never folds a protected block), so
		// no position-based backstop is applied here.
		for (let i = 0; i < messages.length; i++) {
			const info = infos[i];
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
			for (let i = 0; i < messages.length; i++) {
				if (!owner[i]) continue;
				for (const c of infos[i].calls) calls.add(c);
				for (const c of infos[i].results) results.add(c);
			}
			for (let i = 0; i < messages.length; i++) {
				if (!owner[i]) continue;
				const info = infos[i];
				if (info.calls.some((c) => !results.has(c)) || info.results.some((c) => !calls.has(c))) {
					owner[i] = null; // straggler: a tool-pair half is outside → keep this message live
					changedSet = true;
				}
			}
		}
	}

	// ── Phase B: build the output — collapse runs, fold survivors in place ────────
	let changed = false;
	const mark = () => {
		changed = true;
	};
	const out: PiMessage[] = [];
	for (let i = 0; i < messages.length; ) {
		const g = owner[i];
		if (g) {
			// Consume the maximal consecutive run owned by the SAME group → one entry. A
			// group split by an interior straggler yields one entry per run (same summary).
			const role = messages[i].role === "assistant" ? "assistant" : "user";
			let j = i + 1;
			while (j < messages.length && owner[j] === g) j++;
			out.push({ role, content: [{ type: "text", text: g.summaryText }] } as PiMessage);
			changed = true;
			i = j;
			continue;
		}
		out.push(foldOne(messages[i], i, byId, mark));
		i++;
	}
	return changed ? out : messages;
}

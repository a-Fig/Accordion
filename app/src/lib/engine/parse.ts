/*
 * parse.ts — raw session transcript (pi or Claude Code JSONL) → typed Blocks.
 *
 * A single assistant message is split into its constituent blocks (thinking,
 * reply text, each tool call). Tool results become their own blocks, linked back
 * to their call by id. Turn numbers increment on real user messages so blocks
 * stay grouped by the human exchange they belong to.
 */
import type { Block, BlockKind, ParsedSession, SessionMeta } from "./types";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";

function parseLines(raw: string): any[] {
	const out: any[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			/* tolerate the odd broken line */
		}
	}
	return out;
}

function detectFormat(entries: any[]): SessionMeta["format"] {
	if (!entries.length) return "unknown";
	if (entries[0]?.type === "session") return "pi";
	for (const e of entries.slice(0, 12)) {
		if (e?.uuid && (e.type === "user" || e.type === "assistant")) return "claude";
	}
	return "unknown";
}

const asText = (c: unknown): string => {
	if (typeof c === "string") return c;
	if (Array.isArray(c))
		return c
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n");
	return "";
};

/** Builder that assigns stable ids, global order, and the running turn number. */
class Sink {
	blocks: Block[] = [];
	private order = 0;
	turn = 0;

	push(
		id: string,
		kind: BlockKind,
		text: string,
		extra: Partial<Pick<Block, "toolName" | "callId" | "model" | "isError">> = {},
	): void {
		if (!text && kind !== "tool_result") return; // drop empty non-results
		this.blocks.push({
			id,
			kind,
			turn: this.turn,
			order: this.order++,
			text,
			tokens: estTokens(text) + BLOCK_OVERHEAD,
			override: null,
			autoFolded: false,
			by: null,
			...extra,
		});
	}
}

// ---- pi -------------------------------------------------------------------
function parsePi(entries: any[]): ParsedSession {
	const meta: SessionMeta = { format: "pi", title: "", cwd: "", model: "" };
	const sink = new Sink();
	let skipped = 0;
	let ei = 0;

	for (const e of entries) {
		const eid = e.id || `__e${ei++}`; // monotonic fallback — never collides
		switch (e.type) {
			case "session":
				meta.cwd = e.cwd || "";
				meta.title = e.title || "";
				break;
			case "message": {
				const m = e.message || {};
				if (m.role === "user") {
					sink.turn += 1;
					sink.push(`${eid}:u`, "user", asText(m.content));
				} else if (m.role === "assistant") {
					if (m.model) meta.model = m.model;
					const content = Array.isArray(m.content) ? m.content : [];
					let i = 0;
					for (const b of content) {
						if (b?.type === "thinking") sink.push(`${eid}:${i}`, "thinking", b.thinking || "", { model: m.model });
						else if (b?.type === "text") sink.push(`${eid}:${i}`, "text", b.text || "", { model: m.model });
						else if (b?.type === "toolCall")
							sink.push(`${eid}:${i}`, "tool_call", `${b.name} ${JSON.stringify(b.arguments ?? {})}`, {
								toolName: b.name,
								callId: b.id,
								model: m.model,
							});
						else skipped++;
						i++;
					}
				} else if (m.role === "toolResult") {
					sink.push(`${eid}:r`, "tool_result", asText(m.content), {
						toolName: m.toolName || "tool",
						callId: m.toolCallId,
						isError: !!m.isError,
					});
				} else skipped++;
				break;
			}
			case "compaction":
				// A prior native compaction in the source — record it as a result-like marker.
				sink.push(`${eid}:c`, "tool_result", "⤺ native compaction: " + (e.summary || "").slice(0, 400), {
					toolName: "compaction",
				});
				break;
			default:
				skipped++; // model_change, thinking_level_change, mode_change, ...
		}
	}
	if (!meta.title) meta.title = "pi session";
	return { meta, blocks: sink.blocks, lineCount: entries.length, skipped };
}

// ---- Claude Code ----------------------------------------------------------
function parseClaude(entries: any[]): ParsedSession {
	const meta: SessionMeta = { format: "claude", title: "", cwd: "", model: "" };
	const sink = new Sink();
	const toolNames: Record<string, string> = {};
	let skipped = 0;
	let ei = 0;

	for (const e of entries) {
		const eid = e.uuid || `__e${ei++}`; // monotonic fallback — never collides
		if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
		if (e.type === "ai-title" || e.type === "custom-title") {
			meta.title = e.aiTitle || e.customTitle || meta.title;
			continue;
		}
		if (e.type === "assistant") {
			const m = e.message || {};
			if (m.model) meta.model = m.model;
			let i = 0;
			for (const b of m.content || []) {
				if (b?.type === "thinking") sink.push(`${eid}:${i}`, "thinking", b.thinking || "", { model: m.model });
				else if (b?.type === "text") sink.push(`${eid}:${i}`, "text", b.text || "", { model: m.model });
				else if (b?.type === "tool_use") {
					if (b.id) toolNames[b.id] = b.name;
					sink.push(`${eid}:${i}`, "tool_call", `${b.name} ${JSON.stringify(b.input ?? {})}`, {
						toolName: b.name,
						callId: b.id,
						model: m.model,
					});
				} else skipped++;
				i++;
			}
		} else if (e.type === "user") {
			const c = e.message?.content;
			const results = Array.isArray(c) ? c.filter((b: any) => b && b.type === "tool_result") : [];
			if (results.length) {
				let i = 0;
				for (const r of results) {
					const txt = typeof r.content === "string" ? r.content : asText(r.content);
					sink.push(`${eid}:${i++}`, "tool_result", txt, {
						toolName: toolNames[r.tool_use_id] || "tool",
						callId: r.tool_use_id,
						isError: !!r.is_error,
					});
				}
				const utxt = asText(c);
				if (utxt.trim()) {
					sink.turn += 1;
					sink.push(`${eid}:u`, "user", utxt);
				}
			} else {
				const txt = asText(c);
				if (txt.trim()) {
					sink.turn += 1;
					sink.push(`${eid}:u`, "user", txt);
				} else skipped++;
			}
		} else skipped++;
	}
	if (!meta.title) meta.title = "Claude Code session";
	return { meta, blocks: sink.blocks, lineCount: entries.length, skipped };
}

export function parse(raw: string): ParsedSession {
	const entries = parseLines(raw);
	const fmt = detectFormat(entries);
	if (fmt === "pi") return parsePi(entries);
	if (fmt === "claude") return parseClaude(entries);
	throw new Error("Unrecognized session format (expected pi or Claude Code JSONL).");
}

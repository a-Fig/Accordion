/*
 * claude.ts — types and guards for Claude Code session discovery.
 *
 * Plain TS — no Svelte, no runes, no Node built-ins. The Rust command
 * `list_claude_sessions` returns raw JSON values; `isClaudeSession` validates them
 * before the app uses them, mirroring how `isLiveEntry` defensively checks fields.
 */

/** One Claude Code session discovered from ~/.claude/projects/**&#47;*.jsonl. */
export interface ClaudeCodeSession {
	/** .jsonl filename without extension */
	sessionId: string;
	/** absolute path to the .jsonl transcript file */
	filePath: string;
	title: string;
	cwd: string;
	project: string;
	/** last-modified time, epoch milliseconds */
	mtime: number;
	/** file size in bytes */
	size: number;
}

/**
 * Runtime guard — true when `e` is a well-formed ClaudeCodeSession.
 * The Rust command returns raw JSON; this validates every field before use.
 */
export function isClaudeSession(e: unknown): e is ClaudeCodeSession {
	if (!e || typeof e !== "object") return false;
	const v = e as Record<string, unknown>;
	return (
		typeof v.sessionId === "string" &&
		v.sessionId.length > 0 &&
		typeof v.filePath === "string" &&
		v.filePath.length > 0 &&
		typeof v.title === "string" &&
		typeof v.cwd === "string" &&
		typeof v.project === "string" &&
		typeof v.mtime === "number" &&
		Number.isFinite(v.mtime) &&
		typeof v.size === "number" &&
		Number.isFinite(v.size)
	);
}

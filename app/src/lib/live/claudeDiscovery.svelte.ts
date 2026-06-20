/*
 * claudeDiscovery.svelte.ts — reactive discovery of Claude Code session transcripts.
 *
 * Mirrors discovery.svelte.ts (the pi-session equivalent). Polls the native Tauri
 * command `list_claude_sessions` (which scans ~/.claude/projects&#47;**&#47;*.jsonl),
 * keeps a reactive sorted list for the sidebar, and exposes start/stop/select helpers.
 *
 * Outside Tauri (plain browser dev) the native command doesn't exist, so this
 * stays a silent no-op and the sidebar section is simply empty.
 */
import { isClaudeSession, type ClaudeCodeSession } from "./claude";

export const claudeDiscovery = $state<{
	sessions: ClaudeCodeSession[];
	selected: string | null; // selected ClaudeCodeSession.sessionId, or null
}>({ sessions: [], selected: null });

let _timer: ReturnType<typeof setInterval> | null = null;
let _refreshing = false; // re-entrancy guard — a slow 50-file head-scan must not pile up

async function refreshClaude(): Promise<void> {
	// Mirror discovery.poll's overlap guard: list_claude_sessions does real disk I/O
	// (stat ~900 files + head-read up to 50×96KB). If a scan outruns the 3s tick, skip
	// the new one rather than queue concurrent invokes.
	if (_refreshing) return;
	_refreshing = true;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const raw = await invoke<unknown[]>("list_claude_sessions");
		// Rust list_claude_sessions guarantees mtime-descending order; filter is order-stable.
		const sessions: ClaudeCodeSession[] = raw.filter(isClaudeSession);
		claudeDiscovery.sessions = sessions;
	} catch {
		// Not Tauri, command missing, or transient error — leave prior list intact.
	} finally {
		_refreshing = false;
	}
}

export function startClaudeDiscovery(): void {
	if (_timer !== null) return; // idempotent — already running
	void refreshClaude();
	_timer = setInterval(() => void refreshClaude(), 3000);
}

export function stopClaudeDiscovery(): void {
	if (_timer !== null) {
		clearInterval(_timer);
		_timer = null;
	}
	// Intentionally do NOT clear sessions — avoids a flash-to-empty when re-entering the tab.
}


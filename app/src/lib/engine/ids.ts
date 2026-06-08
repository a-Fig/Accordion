/**
 * The "message key" of a block id — the id with its assistant-part suffix removed,
 * so every part of one assistant message shares a key while scalar user/result/summary
 * blocks remain their own key.
 *
 * Two id regimes share the app:
 *  • LIVE wire (`live/mapping.ts`): assistant part = `a:<anchor>:p<j>` / `m<i>:p<j>`.
 *  • LOADED transcripts (`engine/parse.ts`): assistant part = `<eid>:<j>` (bare numeric).
 *
 * Scalar durable ids like `u:<ts>` / `s:<ts>` / `r:<callId>` must NOT be stripped.
 */
export function messageKey(id: string): string {
	const live = id.match(/^(.*):p(?:\d+|\?)$/);
	if (live) return live[1];
	const parsed = id.match(/^(.+):\d+$/);
	if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
	return id;
}

/**
 * Formats a Unix-millisecond timestamp as a short relative-time string:
 * "now" (<60 s), "Nm" (<60 min), "Nh" (<24 h), "Nd" (<7 d), or a short
 * locale date (e.g. "Jun 7") for anything older.
 */
export function relTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
	const d = new Date(ms);
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

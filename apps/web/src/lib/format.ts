/** Display helpers for desk timestamps and durations (Northline mono chips). */

export function formatDateTime(
	value: string | number | Date | null | undefined,
): string {
	if (value == null || value === "") return "—";
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/** Compact duration for UI chips, e.g. 842ms / 1.2s / 1m 05s */
export function formatDurationMs(ms: number | null | undefined): string {
	if (ms == null || Number.isNaN(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
	const mins = Math.floor(seconds / 60);
	const rem = Math.round(seconds % 60);
	return `${mins}m ${String(rem).padStart(2, "0")}s`;
}

export function formatScore(score: number | null | undefined): string {
	if (score == null || Number.isNaN(score)) return "—";
	return score.toFixed(2);
}

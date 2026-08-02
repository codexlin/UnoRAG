/** Display helpers for timestamps and durations (Northline mono chips). */

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

/** Human-readable file size, e.g. 340 KB / 1.2 MB. Null/unknown → — */
export function formatFileSize(bytes: number | null | undefined): string {
	if (bytes == null || Number.isNaN(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB"] as const;
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const formatted =
		value >= 100
			? String(Math.round(value))
			: value.toFixed(1).replace(/\.0$/, "");
	return `${formatted} ${units[unit]}`;
}

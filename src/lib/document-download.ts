function safeDownloadFilename(filename: string): string {
	return (
		filename
			.toWellFormed()
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip controls from HTTP download filenames.
			.replace(/[\u0000-\u001f\u007f/\\]/g, "_")
			.trim()
	);
}

export function documentContentDisposition(filename: string): string {
	const name = safeDownloadFilename(filename) || "document";
	const fallback = name.replace(/[^\x20-\x7e]|["%]/g, "_");
	const encoded = encodeURIComponent(name).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function documentDownloadFilename(
	disposition: string | null,
): string | undefined {
	if (!disposition) return undefined;
	const extended = disposition.match(
		/(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]*)/i,
	);
	if (extended) {
		try {
			const name = safeDownloadFilename(decodeURIComponent(extended[1].trim()));
			if (name) return name;
		} catch {
			// A malformed extended value must not prevent the plain-name fallback.
		}
	}
	const plain = disposition.match(
		/(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i,
	);
	const name = plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2];
	return name ? safeDownloadFilename(name) || undefined : undefined;
}

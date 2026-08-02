import path from "node:path";

export function safeStorageFilename(filename) {
	const basename = path.basename(filename.normalize("NFKC")).slice(0, 240);
	const safe = basename
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 180);
	return safe || "document";
}

export function resolveStoragePath(root, key) {
	if (!key || path.isAbsolute(key) || key.includes("\\")) {
		throw new Error("invalid object storage key");
	}
	const segments = key.split("/");
	if (
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("invalid object storage key");
	}
	const normalizedRoot = path.resolve(root);
	const resolved = path.resolve(normalizedRoot, ...segments);
	if (!resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
		throw new Error("object storage key escapes configured root");
	}
	return resolved;
}

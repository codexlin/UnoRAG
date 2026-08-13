export function validateStorageKey(key: string): string {
	if (!key || key.startsWith("/") || key.includes("\\")) {
		throw new Error("invalid object storage key");
	}
	const segments = key.split("/");
	if (
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("invalid object storage key");
	}
	return key;
}

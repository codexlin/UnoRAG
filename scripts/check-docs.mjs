import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const markdownFiles = execFileSync("git", ["ls-files", "-z", "--", "*.md"])
	.toString("utf8")
	.split("\0")
	.filter(Boolean)
	.filter((file) => existsSync(path.join(root, file)));
const documentationFiles = markdownFiles.filter(
	(file) => !file.startsWith("testdata/"),
);
const retiredDocumentationPaths = new Set([
	"docs/PRODUCT.md",
	"docs/LANGFUSE.md",
	"docs/contracts/retrieve-ask-v1.md",
	"docs/design/observability.md",
	"docs/design/hybrid-retrieval.md",
	"docs/evidence/2026-09-15-library-crud-audit.md",
	"docs/evidence/2026-09-17-library-delete-fault-recovery.md",
]);
const errors = [];

for (const file of documentationFiles) {
	if (retiredDocumentationPaths.has(file)) {
		errors.push(`${file}: retired documentation path must not be restored`);
	}
}

function linkDestination(raw) {
	const value = raw.trim();
	if (value.startsWith("<")) {
		const closing = value.indexOf(">");
		return closing === -1 ? value : value.slice(1, closing);
	}
	return value.split(/\s+/u, 1)[0];
}

for (const file of documentationFiles) {
	const absolute = path.join(root, file);
	const content = readFileSync(absolute, "utf8");
	if (/\/Users\/|[A-Za-z]:\\Users\\|\/tmp\/codex/u.test(content)) {
		errors.push(`${file}: contains a local workstation path`);
	}

	for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/gu)) {
		const destination = linkDestination(match[1]);
		if (
			!destination ||
			destination.startsWith("#") ||
			destination.startsWith("/") ||
			/^[a-z][a-z0-9+.-]*:/iu.test(destination)
		) {
			continue;
		}
		const withoutFragment = destination.split("#", 1)[0];
		if (!withoutFragment) continue;
		let decoded;
		try {
			decoded = decodeURIComponent(withoutFragment);
		} catch {
			errors.push(`${file}: malformed link encoding: ${destination}`);
			continue;
		}
		const target = path.resolve(path.dirname(absolute), decoded);
		if (!existsSync(target)) {
			errors.push(`${file}: broken local link: ${destination}`);
		}
	}
}

const evidenceDirectory = path.join(root, "docs/evidence");
const evidenceIndex = readFileSync(
	path.join(evidenceDirectory, "README.md"),
	"utf8",
);
const evidenceReports = readdirSync(evidenceDirectory)
	.filter((file) => file.endsWith(".md") && file !== "README.md")
	.sort();
for (const report of evidenceReports) {
	if (!evidenceIndex.includes(`./${report}`)) {
		errors.push(`docs/evidence/README.md: missing report entry: ${report}`);
	}
}

if (errors.length > 0) {
	console.error(`Documentation check failed (${errors.length}):`);
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(
	`Documentation check passed: ${documentationFiles.length} files, ${evidenceReports.length} evidence reports.`,
);

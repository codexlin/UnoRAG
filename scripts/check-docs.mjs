import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const root = process.cwd();
const markdownFiles = execFileSync("git", [
	"ls-files",
	"--cached",
	"--others",
	"--exclude-standard",
	"-z",
	"--",
	"*.md",
])
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
	"docs/adr/0001-ocr-vlm-adapters.md",
	"docs/adr/0004-nextjs-control-plane.md",
	"docs/adr/0006-private-product-monorepo.md",
]);
const errors = [];

for (const file of documentationFiles) {
	if (retiredDocumentationPaths.has(file)) {
		errors.push(`${file}: retired documentation path must not be restored`);
	}
}

const markdown = unified().use(remarkParse).use(remarkGfm);
function linkDestinations(content) {
	const destinations = [];
	function visit(node) {
		if (["link", "image", "definition"].includes(node.type)) {
			destinations.push(node.url);
		}
		for (const child of node.children ?? []) visit(child);
	}
	visit(markdown.parse(content));
	return destinations;
}

for (const file of documentationFiles) {
	const absolute = path.join(root, file);
	const content = readFileSync(absolute, "utf8");
	if (/\/Users\/|[A-Za-z]:\\Users\\|\/tmp\/codex/u.test(content)) {
		errors.push(`${file}: contains a local workstation path`);
	}

	for (const destination of linkDestinations(content)) {
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
const datedReports = evidenceReports.filter((file) =>
	/^\d{4}-\d{2}-\d{2}-/u.test(file),
);
if (datedReports.length !== 1) {
	errors.push(
		"docs/evidence: keep exactly one current dated release report; link historical reports to immutable Git commits",
	);
}
const indexedReports = new Set(linkDestinations(evidenceIndex));
for (const report of evidenceReports) {
	if (!indexedReports.has(`./${report}`)) {
		errors.push(`docs/evidence/README.md: missing report entry: ${report}`);
	}
}

if (errors.length > 0) {
	console.error(`Documentation check failed (${errors.length}):`);
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(
	`Documentation check passed: ${documentationFiles.length} files, ${evidenceReports.length} evidence documents (${datedReports.length} current release report).`,
);

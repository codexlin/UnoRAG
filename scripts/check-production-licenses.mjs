#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// Every expression here was reviewed as part of the 2026-08-06 inventory. This
// gate detects dependency drift; it does not replace attribution or legal review.
const reviewedExpressions = new Set([
	"(AFL-2.1 OR BSD-3-Clause)",
	"(MIT AND Zlib)",
	"(MIT OR CC0-1.0)",
	"(MIT OR GPL-3.0-or-later)",
	"0BSD",
	"Apache-2.0",
	"BSD",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"CC-BY-4.0",
	"ISC",
	"LGPL-3.0-or-later",
	"MIT",
	"OFL-1.1",
]);

const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
	encoding: "utf8",
});

if (result.status !== 0) {
	process.stderr.write(
		result.stderr || "Unable to inventory production licenses.\n",
	);
	process.exit(result.status ?? 1);
}

let inventory;
try {
	inventory = JSON.parse(result.stdout);
} catch (error) {
	console.error(
		"pnpm returned an invalid production license inventory.",
		error,
	);
	process.exit(1);
}

const expressions = Object.keys(inventory).sort();
const unreviewed = expressions.filter(
	(expression) => !reviewedExpressions.has(expression),
);
const packageCount = Object.values(inventory).reduce(
	(total, packages) => total + packages.length,
	0,
);

console.log(
	`Reviewed ${packageCount} production package entries across ${expressions.length} license expressions.`,
);

if (unreviewed.length > 0) {
	console.error("Unreviewed production license expressions:");
	for (const expression of unreviewed) console.error(`- ${expression}`);
	console.error(
		"Review the dependency, distribution obligations, image contents and notices before updating this allowlist.",
	);
	process.exit(1);
}

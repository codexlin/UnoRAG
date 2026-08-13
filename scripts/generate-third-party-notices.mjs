#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import spdxLicenses from "spdx-license-list/full.js";

const outputPath = process.argv[2];
const pnpmResult = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (pnpmResult.status !== 0) {
	throw new Error(
		pnpmResult.stderr || "pnpm production license inventory failed",
	);
}

const checkerResult = spawnSync(
	"pnpm",
	["exec", "license-checker-rseidelsohn", "--json", "--start", "."],
	{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (checkerResult.status !== 0) {
	throw new Error(checkerResult.stderr || "license text discovery failed");
}

const pnpmInventory = JSON.parse(pnpmResult.stdout);
const checkerInventory = JSON.parse(checkerResult.stdout);
const groups = new Map();
const productionPackages = [];

for (const [license, packages] of Object.entries(pnpmInventory)) {
	for (const metadata of packages) {
		for (const [index, version] of metadata.versions.entries()) {
			productionPackages.push({
				nameVersion: `${metadata.name}@${version}`,
				license,
				packagePath: metadata.paths[index] ?? metadata.paths[0],
				homepage: metadata.homepage ?? "not declared",
				author: metadata.author ?? "not declared",
			});
		}
	}
}

for (const metadata of productionPackages.sort((a, b) =>
	a.nameVersion.localeCompare(b.nameVersion),
)) {
	const { nameVersion, license, packagePath, homepage, author } = metadata;
	const packagedLicense = (await readdir(packagePath)).find((file) =>
		/^(licen[sc]e|copying|notice)(\.|$)/i.test(file),
	);
	let licenseText;
	if (packagedLicense)
		licenseText = await readFile(
			path.join(packagePath, packagedLicense),
			"utf8",
		);
	else if (
		checkerInventory[nameVersion]?.licenseFile &&
		/^(licen[sc]e|copying|notice)(\.|$)/i.test(
			path.basename(checkerInventory[nameVersion].licenseFile),
		)
	) {
		licenseText = await readFile(
			checkerInventory[nameVersion].licenseFile,
			"utf8",
		);
	} else if (spdxLicenses[license]?.licenseText) {
		licenseText = [
			"The package archive does not contain a standalone license file.",
			`Declared SPDX license: ${license}`,
			`Author: ${author}`,
			`Project: ${homepage}`,
			"The canonical SPDX license text follows:",
			"",
			spdxLicenses[license].licenseText,
		].join("\n");
	} else {
		throw new Error(`No distributable license text found for ${nameVersion}`);
	}
	const normalized = licenseText.trim().replaceAll("\r\n", "\n");
	const digest = createHash("sha256").update(normalized).digest("hex");
	const group = groups.get(digest) ?? { licenseText: normalized, packages: [] };
	group.packages.push(`${nameVersion} [${license}]`);
	groups.set(digest, group);
}

const lines = [
	"UnoRAG third-party license bundle",
	"Generated from the production dependency tree. Do not edit by hand.",
	"",
];
for (const group of [...groups.values()].sort((a, b) =>
	a.packages[0].localeCompare(b.packages[0]),
)) {
	lines.push(
		"=".repeat(80),
		...group.packages.sort(),
		"-".repeat(80),
		group.licenseText,
		"",
	);
}
const bundle = `${lines.join("\n")}\n`;

if (outputPath) {
	await writeFile(path.resolve(outputPath), bundle, "utf8");
	console.log(
		`Wrote ${productionPackages.length} package notices to ${outputPath}.`,
	);
} else {
	console.log(
		`Verified license text coverage for ${productionPackages.length} production package entries.`,
	);
}

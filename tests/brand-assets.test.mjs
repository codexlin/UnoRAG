import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);

test("the Uno family uses one canonical SVG source without implicit ICO overrides", async () => {
	const markUrl = new URL("public/brand/uno-mark.svg", appRoot);
	const componentUrl = new URL("src/components/app/unorag-logo.tsx", appRoot);

	await Promise.all([
		access(markUrl),
		access(new URL("public/brand/uno-mark.png", appRoot)),
		access(new URL("public/favicon-32x32.png", appRoot)),
		access(new URL("public/apple-touch-icon.png", appRoot)),
	]);

	const [mark, component] = await Promise.all([
		readFile(markUrl, "utf8"),
		readFile(componentUrl, "utf8"),
	]);
	assert.match(mark, /<title[^>]*>Uno<\/title>/);
	assert.match(mark, /U, N and O/);
	assert.match(component, /\/brand\/uno-mark\.svg/);
	assert.match(component, /suffix=\{withWordmark \? "RAG" : undefined\}/);

	for (const path of ["public/favicon.ico", "src/app/favicon.ico"]) {
		await assert.rejects(access(new URL(path, appRoot)), { code: "ENOENT" });
	}
});

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { DomUtils, parseDocument } from "htmlparser2";

const appRoot = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");

async function svgAsset(name) {
	const source = await readFile(new URL(`public/brand/${name}`, appRoot));
	const document = parseDocument(source.toString(), { xmlMode: true });
	const root = DomUtils.getElementsByTagName("svg", document.children)[0];
	assert.ok(root, `${name} must contain an SVG root`);
	return { source, root };
}

test("the canonical Uno symbol is accessible native geometry with a transparent canvas", async () => {
	const { root } = await svgAsset("uno-mark.svg");
	assert.equal(root.attribs.viewBox, "0 0 128 128");
	assert.equal(root.attribs.role, "img");
	const ids = root.attribs["aria-labelledby"].split(/\s+/);
	for (const id of ids) {
		const element = DomUtils.getElementById(id, root.children);
		assert.ok(element && DomUtils.textContent(element).trim());
	}
	const title = DomUtils.getElementsByTagName("title", root.children)[0];
	assert.equal(DomUtils.textContent(title), "Uno");
	const paths = DomUtils.getElementsByTagName("path", root.children);
	assert.equal(paths.length, 1);
	assert.equal(paths[0].attribs["fill-rule"], "evenodd");
	assert.equal(paths[0].attribs.fill, "currentColor");
	for (const forbidden of ["image", "script", "foreignObject", "rect"]) {
		assert.equal(
			DomUtils.getElementsByTagName(forbidden, root.children).length,
			0,
		);
	}

	for (const path of ["public/favicon.ico", "src/app/favicon.ico"]) {
		await assert.rejects(access(new URL(path, appRoot)), { code: "ENOENT" });
	}
});

test("white and favicon SVGs preserve the canonical outline rather than introducing another logo", async () => {
	const master = await svgAsset("uno-mark.svg");
	const outline = DomUtils.getElementsByTagName("path", master.root.children)[0]
		.attribs;
	for (const name of ["uno-mark-white.svg", "uno-favicon.svg"]) {
		const { root } = await svgAsset(name);
		assert.equal(root.attribs.viewBox, master.root.attribs.viewBox);
		assert.equal(root.attribs.color, "#ffffff");
		const paths = DomUtils.getElementsByTagName("path", root.children);
		assert.equal(paths.length, 1);
		assert.deepEqual(paths[0].attribs, outline);
		const rects = DomUtils.getElementsByTagName("rect", root.children);
		assert.equal(rects.length, name === "uno-favicon.svg" ? 1 : 0);
		if (rects.length) assert.equal(rects[0].attribs.fill, "#202024");
	}
});

test("raster applications are pixel derivatives of the same SVG sources", async () => {
	for (const [path, size, sourceName, background] of [
		["public/brand/uno-mark.png", 512, "uno-mark.svg"],
		["public/brand/uno-mark-white.png", 512, "uno-mark-white.svg"],
		["public/favicon-16x16.png", 16, "uno-favicon.svg"],
		["public/favicon-32x32.png", 32, "uno-favicon.svg"],
		["public/apple-touch-icon.png", 180, "uno-mark-white.svg", "#202024"],
	]) {
		const { source } = await svgAsset(sourceName);
		let expected = sharp(source).resize(size, size);
		if (background) expected = expected.flatten({ background });
		const expectedPixels = await expected.ensureAlpha().raw().toBuffer();
		const png = await readFile(new URL(path, appRoot));
		const { data, info } = await sharp(png)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		assert.equal(info.width, size, path);
		assert.equal(info.height, size, path);
		assert.ok(
			data.equals(expectedPixels),
			`${path} differs from its vector source`,
		);
		if (background) assert.equal((await sharp(png).metadata()).hasAlpha, false);
	}
});

test("16px native rendering retains an open central counter and nonempty surrounding strokes", async () => {
	const { source } = await svgAsset("uno-mark.svg");
	const { data } = await sharp(source)
		.resize(16, 16)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	assert.equal(
		data[(8 * 16 + 8) * 4 + 3],
		0,
		"central counter must remain transparent",
	);
	let solid = 0;
	for (let i = 3; i < data.length; i += 4) if (data[i] > 200) solid++;
	assert.ok(
		solid > 50 && solid < 180,
		"16px outline must remain nonempty without filling its canvas",
	);
});

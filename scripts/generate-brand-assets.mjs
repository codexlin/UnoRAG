#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DomUtils, parseDocument } from "htmlparser2";

const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");
const source = await readFile("public/brand/uno-mark.svg", "utf8");

function variant(color, background) {
	const document = parseDocument(source, { xmlMode: true });
	const root = DomUtils.getElementsByTagName("svg", document.children)[0];
	if (!root) throw new Error("Canonical Uno SVG is missing its root element.");
	root.attribs.color = color;
	if (background) {
		const path = DomUtils.getElementsByTagName("path", root.children)[0];
		if (!path) throw new Error("Canonical Uno SVG is missing its outline.");
		const rect = parseDocument(
			`<rect width="128" height="128" rx="24" fill="${background}"/>`,
			{ xmlMode: true },
		).children[0];
		DomUtils.prepend(path, rect);
	}
	return DomUtils.getOuterHTML(root, { xmlMode: true });
}

const white = variant("#ffffff");
const favicon = variant("#ffffff", "#202024");
await writeFile("public/brand/uno-mark-white.svg", `${white}\n`);
await writeFile("public/brand/uno-favicon.svg", `${favicon}\n`);

for (const [path, size, svg] of [
	["public/brand/uno-mark.png", 512, source],
	["public/brand/uno-mark-white.png", 512, white],
	["public/favicon-16x16.png", 16, favicon],
	["public/favicon-32x32.png", 32, favicon],
]) {
	await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path);
}
await sharp(Buffer.from(white))
	.resize(180, 180)
	.flatten({ background: "#202024" })
	.png()
	.toFile("public/apple-touch-icon.png");

function mark(x, y, size, svg = source) {
	return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" aria-hidden="true"/>`;
}

const board = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760" role="img" aria-labelledby="title desc">
  <title id="title">Uno brand system board</title>
  <desc id="desc">Selected diagonal-weave Uno symbol, product names, native-size samples and positive and reversed applications.</desc>
  <rect width="1200" height="760" fill="#ffffff"/>
  <g fill="#202024" font-family="Arial,sans-serif">
    <text x="56" y="62" font-size="20" font-weight="600">Uno / Diagonal-weave identity</text>
    <text x="56" y="90" font-size="14" fill="#64646f">User-selected D symbol / Local implementation 2026-11-13 / Not released</text>
    ${mark(56, 138, 180)}
    <text x="278" y="230" font-size="72" font-weight="600">UnoRAG</text>
    <text x="280" y="270" font-size="17" fill="#64646f">Opposing arches. Shared stroke. One enclosed counter.</text>
    <path d="M56 360h1088" stroke="#e4e4e9"/>
    <text x="56" y="405" font-size="14" fill="#64646f">Native-size samples / 16 px uses the favicon tile</text>
    ${mark(56, 470, 16, favicon)}${mark(112, 462, 24)}${mark(176, 454, 32)}${mark(248, 422, 64)}
    <text x="56" y="514" font-size="13" fill="#64646f">16</text><text x="112" y="514" font-size="13" fill="#64646f">24</text><text x="176" y="514" font-size="13" fill="#64646f">32</text><text x="248" y="514" font-size="13" fill="#64646f">64</text>
    <text x="444" y="405" font-size="14" fill="#64646f">Shared family mark / reserved product suffixes</text>
    <text x="444" y="456" font-size="28" font-weight="600">UnoParse</text><text x="444" y="502" font-size="28" font-weight="600">UnoOps</text><text x="444" y="548" font-size="28" font-weight="600">UnoEval</text>
    <text x="56" y="572" font-size="14" fill="#64646f">Ink #202024 / White #FFFFFF / Transparent master</text>
    <text x="56" y="601" font-size="14" fill="#64646f">Keep the outline intact. Tiles are applications, not part of the master.</text>
  </g>
  <rect y="640" width="1200" height="120" fill="#19191d"/>
  ${mark(56, 668, 64, white)}
  <text x="144" y="710" fill="#f1f1f4" font-family="Arial,sans-serif" font-size="30" font-weight="600">UnoRAG</text>
  <text x="710" y="708" fill="#aaaab5" font-family="Arial,sans-serif" font-size="14">The interface theme does not change the identity.</text>
</svg>`;

await writeFile("docs/brand/uno-brand-board.svg", board);
console.log(
	"Generated Uno positive/reversed assets, favicon tiles, Apple icon and brand board from the canonical SVG.",
);

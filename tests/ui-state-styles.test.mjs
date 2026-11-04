import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

test("local UI helpers compile the Base UI state variants and scrollbar utility", async () => {
	const from = fileURLToPath(
		new URL("../src/app/fixture.css", import.meta.url),
	);
	const result = await postcss([tailwindcss({ optimize: false })]).process(
		`
@import "tailwindcss" source(none);
@import "./ui-variants.css";
@source inline("data-open:opacity-50 data-closed:opacity-50 data-checked:opacity-50 data-unchecked:opacity-50 data-selected:opacity-50 data-disabled:opacity-50 data-active:opacity-50 data-horizontal:opacity-50 data-vertical:opacity-50 no-scrollbar");
`,
		{ from, map: false },
	);
	const rules = new Map();
	result.root.walkRules((rule) => rules.set(rule.selector, rule.toString()));
	const variant = (name) =>
		[...rules].find(([selector]) =>
			selector.startsWith(`.data-${name}\\:opacity-50:`),
		)?.[1];
	for (const [name, selector] of [
		["open", 'data-state="open"'],
		["closed", 'data-state="closed"'],
		["checked", 'data-state="checked"'],
		["unchecked", 'data-state="unchecked"'],
		["selected", 'data-selected="true"'],
		["disabled", 'data-disabled="true"'],
		["active", 'data-state="active"'],
		["horizontal", 'data-orientation="horizontal"'],
		["vertical", 'data-orientation="vertical"'],
	]) {
		const rule = variant(name);
		assert.ok(rule, `missing compiled ${name} variant`);
		assert.ok(rule.includes(selector), `missing ${name} attribute selector`);
		assert.ok(rule.includes("opacity: 50%"));
	}
	assert.ok(variant("open").includes('[data-open]:not([data-open="false"])'));
	assert.ok(rules.get(".no-scrollbar").includes("scrollbar-width: none"));
	assert.ok(
		[...rules.keys()].some((selector) =>
			selector.includes("::-webkit-scrollbar"),
		),
	);
	assert.equal(
		result.messages.some((message) => message.type === "warning"),
		false,
	);
});

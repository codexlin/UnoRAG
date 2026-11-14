import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import postcss from "postcss";

import {
	APPEARANCE_INIT_SCRIPT,
	COLOR_THEMES,
	DEFAULT_APPEARANCE,
	normalizeRadius,
	parseAppearance,
	RADIUS_RANGE,
} from "../../src/lib/appearance";

function normalizeCSSValue(value: string) {
	return value
		.trim()
		.replace(/\s+/g, " ")
		.replace(/\d+\.\d+/g, (number) => String(Number(number)));
}

test("appearance accepts registered themes and preserves radius when old or damaged themes fall back", () => {
	assert.deepEqual(
		COLOR_THEMES.map((theme) => theme.id),
		["vercel", "claude", "violet-bloom"],
	);
	for (const raw of [null, "bad json", "null", "7", "[]", '"blue"']) {
		assert.deepEqual(parseAppearance(raw), DEFAULT_APPEARANCE);
	}
	assert.deepEqual(
		parseAppearance('{"color":"claude","radius":"malicious CSS"}'),
		{
			color: "claude",
			radius: 4,
		},
	);
	for (const color of ["neutral", "blue", "url(https://example.com)"]) {
		assert.deepEqual(
			parseAppearance(JSON.stringify({ color, radius: "soft" })),
			{
				color: "vercel",
				radius: 8,
			},
		);
	}
});

test("custom radius clamps finite values, rounds to half pixels and migrates old presets", () => {
	for (const [value, expected] of [
		[0, 0],
		[3.5, 3.5],
		[4.74, 4.5],
		[4.75, 5],
		[8, 8],
		[-12, 0],
		[100, 8],
		["none", 0],
		["balanced", 4],
		["soft", 8],
	] as const) {
		assert.equal(normalizeRadius(value), expected);
		assert.equal(
			parseAppearance(JSON.stringify({ radius: value })).radius,
			expected,
		);
	}
	for (const value of [
		undefined,
		null,
		NaN,
		Infinity,
		-Infinity,
		"5.5",
		"url(bad)",
		{},
		[],
		true,
		"constructor",
		"__proto__",
	])
		assert.equal(normalizeRadius(value), 4);
});

test("pre-paint bootstrap agrees with preference parser for every theme/radius and invalid input", () => {
	const values: (string | null)[] = [
		null,
		"{bad",
		'{"color":"bad","radius":-1}',
		'{"color":"blue","radius":"soft"}',
		'{"color":"claude","radius":100}',
		'{"color":"claude","radius":1e309}',
		'{"color":"claude","radius":"constructor"}',
		'{"color":"claude","radius":4.75}',
	];
	for (const color of COLOR_THEMES)
		for (
			let radius: number = RADIUS_RANGE.min;
			radius <= RADIUS_RANGE.max;
			radius += RADIUS_RANGE.step
		) {
			values.push(JSON.stringify({ color: color.id, radius }));
		}
	for (const raw of values) {
		const dataset: Record<string, string> = {};
		const styles: Record<string, string> = {};
		vm.runInNewContext(APPEARANCE_INIT_SCRIPT, {
			localStorage: { getItem: () => raw },
			document: {
				documentElement: {
					dataset,
					style: {
						setProperty: (key: string, value: string) => {
							styles[key] = value;
						},
					},
				},
			},
		});
		const expected = parseAppearance(raw);
		assert.deepEqual(dataset, {
			colorTheme: expected.color,
			radius: String(expected.radius),
		});
		assert.deepEqual(styles, { "--radius": `${expected.radius}px` });
	}
	const dataset: Record<string, string> = {};
	vm.runInNewContext(APPEARANCE_INIT_SCRIPT, {
		get localStorage() {
			throw new Error("storage denied");
		},
		document: {
			documentElement: { dataset, style: { setProperty: () => {} } },
		},
	});
	assert.deepEqual(dataset, { colorTheme: "vercel", radius: "4" });
});

test("built-in themes are reproducible snapshots with complete colors, local fonts and isolated geometry", () => {
	const cssText = readFileSync(
		new URL("../../src/styles/themes.css", import.meta.url),
		"utf8",
	);
	assert.match(
		execFileSync(
			process.execPath,
			["scripts/generate-theme-styles.mjs", "--check"],
			{ encoding: "utf8" },
		),
		/Verified 3 built-in/,
	);
	const css = postcss.parse(cssText);
	const variables = new Map<string, Record<string, string>>();
	css.walkRules((rule) => {
		const values: Record<string, string> = {};
		rule.walkDecls((decl) => {
			values[decl.prop] = decl.value;
		});
		for (const selector of rule.selectors) variables.set(selector, values);
	});
	const overrides = JSON.parse(
		readFileSync(
			new URL("../../src/styles/themes/overrides.json", import.meta.url),
			"utf8",
		),
	);
	for (const theme of COLOR_THEMES) {
		const upstream = JSON.parse(
			readFileSync(
				new URL(`../../src/styles/themes/${theme.id}.json`, import.meta.url),
				"utf8",
			),
		);
		assert.equal(upstream.name, theme.id);
		for (const mode of ["light", "dark"]) {
			const values = variables.get(
				`:root${mode === "dark" ? ".dark" : ""}[data-color-theme="${theme.id}"]`,
			);
			assert.ok(values, `${theme.id}/${mode}`);
			assert.deepEqual(
				variables.get(
					`${mode === "dark" ? ".dark " : ""}[data-theme-preview="${theme.id}"]`,
				),
				values,
			);
			for (const token of [
				"background",
				"foreground",
				"primary",
				"primary-foreground",
				"card",
				"card-foreground",
				"popover",
				"popover-foreground",
				"secondary",
				"secondary-foreground",
				"muted",
				"muted-foreground",
				"accent",
				"accent-foreground",
				"border",
				"input",
				"ring",
				"chart-1",
				"chart-2",
				"chart-3",
				"chart-4",
				"chart-5",
				"sidebar",
				"sidebar-foreground",
				"sidebar-primary",
				"sidebar-primary-foreground",
				"sidebar-accent",
				"sidebar-accent-foreground",
				"sidebar-border",
				"sidebar-ring",
				"shadow-sm",
				"shadow-lg",
			]) {
				assert.equal(
					normalizeCSSValue(values[`--${token}`]),
					normalizeCSSValue(
						overrides[theme.id]?.[mode]?.[token] ??
							upstream.cssVars[mode][token],
					),
					`${theme.id}/${mode}/${token}`,
				);
			}
			for (const token of [
				"--cite",
				"--survey",
				"--destructive",
				"--warning",
				"--radius",
				"--spacing",
				"--tracking-normal",
			]) {
				assert.equal(
					values[token],
					undefined,
					`${theme.id} must not override ${token}`,
				);
			}
			assert.ok(values["--theme-font-sans"]);
			assert.ok(values["--theme-font-mono"]);
			assert.equal(
				normalizeCSSValue(values["--evidence"]),
				normalizeCSSValue(
					overrides[theme.id]?.[mode]?.evidence ??
						overrides[theme.id]?.[mode]?.primary ??
						upstream.cssVars[mode].primary,
				),
			);
		}
	}
	assert.doesNotMatch(cssText, /https?:|@import|url\(/);
});

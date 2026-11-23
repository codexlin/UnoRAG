import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.cwd(), "../../public/landing-media");
mkdirSync(outDir, { recursive: true });

const jobs = [
	{ id: "UnoRAGHeroFilm", prefix: "hero", posterFrame: 78 },
	{ id: "UnoRAGLibraryFilm", prefix: "library", posterFrame: 210 },
	{ id: "UnoRAGTraceFilm", prefix: "trace", posterFrame: 235 },
];

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const onlySet = onlyArg
	? new Set(onlyArg.slice("--only=".length).split(","))
	: null;

const locales = [
	{ code: "en", locale: "en" },
	{ code: "zh", locale: "zh-CN" },
];
const themes = ["light", "dark"];

function run(args) {
	const res = spawnSync("npx", ["remotion", ...args], {
		stdio: "inherit",
		env: process.env,
	});
	if (res.status !== 0) {
		process.exit(res.status ?? 1);
	}
}

for (const job of jobs) {
	if (onlySet && !onlySet.has(job.prefix)) continue;
	for (const { code, locale } of locales) {
		for (const theme of themes) {
			const props = JSON.stringify({ locale, theme });
			const base = resolve(outDir, `${job.prefix}-${code}-${theme}`);
			console.log(`\n=== Rendering ${job.id} (${code}/${theme}) ===`);
			run([
				"render",
				"src/index.ts",
				job.id,
				`${base}.mp4`,
				`--props=${props}`,
				"--codec=h264",
				"--crf=24",
				"--pixel-format=yuv420p",
				"--muted",
				"--log=error",
			]);
			run([
				"still",
				"src/index.ts",
				job.id,
				`${base}.png`,
				`--frame=${job.posterFrame}`,
				`--props=${props}`,
				"--log=error",
			]);
		}
	}
}
console.log("\nRendered all 12 MP4 reels and 12 PNG posters to public/landing-media/");

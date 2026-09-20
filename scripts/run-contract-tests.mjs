import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contractTestFiles } from "./test-suites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
	process.execPath,
	["--import", "tsx", "--test", ...contractTestFiles],
	{
		cwd: root,
		stdio: "inherit",
		env: process.env,
	},
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);

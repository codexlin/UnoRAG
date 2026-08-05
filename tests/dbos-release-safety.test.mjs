import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { drainSnapshot } from "../scripts/check-dbos-drain.mjs";

async function source(path) {
	return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("drain snapshot blocks on either application or DBOS work", () => {
	assert.deepEqual(
		drainSnapshot({
			applicationVersion: "unorag-0123456789abcdef",
			appRows: [{ status: "running", count: 1 }],
			dbosRows: [],
			scope: "all",
		}),
		{
			drained: false,
			application_version: "unorag-0123456789abcdef",
			scope: "all",
			app: {
				active: 1,
				by_status: [{ status: "running", count: 1 }],
			},
			dbos: { active: 0, by_status: [] },
		},
	);
	assert.equal(
		drainSnapshot({
			applicationVersion: "unorag-0123456789abcdef",
			appRows: [],
			dbosRows: [{ status: "DELAYED", count: "2" }],
			scope: "all",
		}).drained,
		false,
	);
	assert.equal(
		drainSnapshot({
			applicationVersion: "unorag-0123456789abcdef",
			appRows: [],
			dbosRows: [],
			scope: "all",
		}).drained,
		true,
	);
});

test("release manifests derive DBOS version from the immutable git SHA", async () => {
	const localRelease = await source("scripts/release/local-images.sh");
	const releaseWorkflow = await source(".github/workflows/release-images.yml");
	assert.match(localRelease, /echo "unorag-\$\{sha:0:16\}"/);
	assert.match(releaseWorkflow, /dbos_version=unorag-\$\{GITHUB_SHA::16\}/);
	assert.doesNotMatch(localRelease, /DBOS_APPLICATION_VERSION=lifecycle-v2/);
	assert.doesNotMatch(releaseWorkflow, /DBOS_APPLICATION_VERSION=lifecycle-v2/);
});

test("version-changing upgrades quiesce before migrations and rollback", async () => {
	const upgrade = await source("deploy/compose/scripts/upgrade.sh");
	const quiesce = upgrade.indexOf(
		'quiesce_dbos_version "$CURRENT_DBOS_VERSION"',
	);
	const migration = upgrade.indexOf(
		'log "applying forward-only database migration"',
	);
	assert.ok(quiesce > 0 && quiesce < migration);
	assert.match(
		upgrade,
		/draining target DBOS version before automatic rollback/,
	);
	assert.match(upgrade, /run_drain_check "\$version" app 0/);
	assert.match(upgrade, /run_drain_check "\$version" dbos/);
});

test("the ops image and Compose profile include the drain checker", async () => {
	const dockerfile = await source("deploy/docker/web.Dockerfile");
	const compose = await source("deploy/compose/docker-compose.yml");
	assert.match(dockerfile, /scripts\/check-dbos-drain\.mjs/);
	assert.match(compose, /check-dbos-drain:/);
	assert.match(compose, /DBOS_SYSTEM_DATABASE_URL:/);
});

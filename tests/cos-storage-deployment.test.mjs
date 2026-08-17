import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Compose validates COS configuration and separates credentials", async () => {
	const [install, runtime, secrets, compose] = await Promise.all([
		source("deploy/compose/scripts/install.sh"),
		source("deploy/config/runtime.env.example"),
		source("deploy/config/runtime.secret.example"),
		source("deploy/compose/docker-compose.yml"),
	]);
	assert.match(install, /COS_BUCKET COS_REGION COS_SECRET_ID COS_SECRET_KEY/);
	assert.match(runtime, /^DOCUMENT_STORAGE_DRIVER=local$/m);
	assert.match(runtime, /^COS_PUBLIC_BASE_URL=$/m);
	assert.doesNotMatch(runtime, /^COS_SECRET_(ID|KEY)=/m);
	assert.match(secrets, /^COS_SECRET_ID=$/m);
	assert.match(secrets, /^COS_SECRET_KEY=$/m);
	assert.match(compose, /dbos-worker:[\s\S]*COS_SECRET_KEY/);
});

test("backup and restore fail closed across local and COS storage boundaries", async () => {
	const [backup, restore] = await Promise.all([
		source("deploy/compose/scripts/backup.sh"),
		source("deploy/compose/scripts/restore.sh"),
	]);
	assert.match(backup, /document_storage_driver=\$\{STORAGE_DRIVER\}/);
	assert.match(backup, /documents\.cos\.txt/);
	assert.match(backup, /Enable COS versioning/);
	assert.match(restore, /backup storage driver .* does not match runtime/);
	assert.match(restore, /COS objects are external and are not overwritten/);
});

test("deployment docs record the working CAM user-policy shape", async () => {
	const deployment = await source("docs/DEPLOYMENT.md");
	assert.match(deployment, /cos:PutObjectACL/);
	assert.match(
		deployment,
		/qcs::cos:ap-hongkong:uid\/1311896385:unobyte-1311896385\/org\/\*/,
	);
	assert.match(deployment, /name\/cos:PutObject/);
	assert.match(deployment, /prefix\/\//);
	assert.match(deployment, /pnpm smoke:cos/);
});

test("Helm rejects incomplete or contradictory object storage topology", async () => {
	const template = await source("deploy/helm/unorag/templates/configmap.yaml");
	assert.match(template, /objectStorage\.driver must be local or cos/);
	assert.match(
		template,
		/local object storage requires persistence\.enabled=true/,
	);
	assert.match(
		template,
		/COS object storage requires persistence\.enabled=false/,
	);
	assert.match(
		template,
		/requires objectStorage\.cos\.bucket and objectStorage\.cos\.region/,
	);
});

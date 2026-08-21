import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
	const install = await source("deploy/compose/scripts/install.sh");
	const upgrade = await source("deploy/compose/scripts/upgrade.sh");
	assert.match(localRelease, /echo "unorag-\$\{sha:0:16\}"/);
	assert.match(releaseWorkflow, /dbos_version=unorag-\$\{GITHUB_SHA::16\}/);
	assert.match(releaseWorkflow, /image_platform=linux\/amd64/);
	assert.match(releaseWorkflow, /version=\$\{product_version\}/);
	assert.match(releaseWorkflow, /revision=\$\{GITHUB_SHA\}/);
	assert.match(releaseWorkflow, /UNORAG_VERSION=\$\{VERSION\}/);
	assert.match(releaseWorkflow, /UNORAG_REVISION=\$\{REVISION\}/);
	assert.match(releaseWorkflow, /UNORAG_BUILD_TIME=\$\{BUILD_TIME\}/);
	assert.match(releaseWorkflow, /platforms: linux\/amd64/);
	assert.match(releaseWorkflow, /UNORAG_IMAGE_PLATFORM=\$\{IMAGE_PLATFORM\}/);
	assert.match(
		releaseWorkflow,
		/org\.opencontainers\.image\.licenses=Apache-2\.0/,
	);
	assert.match(
		releaseWorkflow,
		/org\.opencontainers\.image\.version=\$\{\{ steps\.meta\.outputs\.version \}\}/,
	);
	assert.match(
		releaseWorkflow,
		/sbom: \$\{\{ steps\.meta\.outputs\.dry_run != 'true' \}\}/,
	);
	assert.match(
		releaseWorkflow,
		/provenance: \$\{\{ steps\.meta\.outputs\.dry_run != 'true' \}\}/,
	);
	assert.match(releaseWorkflow, /publish_acr=false/);
	assert.match(releaseWorkflow, /PUBLISH_ACR/);
	assert.match(releaseWorkflow, /Mirror runtime manifests to ACR/);
	assert.match(releaseWorkflow, /id-token: write/);
	assert.match(releaseWorkflow, /sigstore\/cosign-installer@6f9f177/);
	assert.match(releaseWorkflow, /cosign sign --yes/);
	assert.match(releaseWorkflow, /--certificate-identity "\$\{identity\}"/);
	assert.match(releaseWorkflow, /UNORAG_VERIFY_IMAGE_SIGNATURES=true/);
	assert.match(
		releaseWorkflow,
		/sign_and_verify "\$\{ACR_REPO\}" "\$\{ACR_WEB_DIGEST\}" legacy/,
	);
	assert.match(releaseWorkflow, /--registry-referrers-mode=legacy/);
	assert.match(releaseWorkflow, /--use-signing-config=false/);
	assert.match(releaseWorkflow, /UNORAG_COSIGN_NEW_BUNDLE_FORMAT=false/);
	assert.match(releaseWorkflow, /UNORAG_COSIGN_REGISTRY_REFERRERS_MODE=legacy/);
	for (const deploymentScript of [install, upgrade]) {
		assert.match(deploymentScript, /UNORAG_COSIGN_NEW_BUNDLE_FORMAT/);
		assert.match(deploymentScript, /UNORAG_COSIGN_REGISTRY_REFERRERS_MODE/);
	}
	assert.match(
		releaseWorkflow,
		/docker pull --platform "\$\{IMAGE_PLATFORM\}"/,
	);
	assert.match(releaseWorkflow, /ACR_WEB_DIGEST/);
	assert.match(
		releaseWorkflow,
		/UNORAG_WEB_IMAGE=\$\{ACR_REPO\}@\$\{ACR_WEB_DIGEST\}/,
	);
	assert.doesNotMatch(
		releaseWorkflow,
		/web_tags=\$\{ghcr_repo\}[^\n]*,\$\{acr_repo\}/,
	);
	assert.match(localRelease, /UNORAG_IMAGE_PLATFORM=\$\{image_platform\}/);
	assert.match(localRelease, /UNORAG_VERSION=\$\{PRODUCT_VERSION\}/);
	assert.match(localRelease, /UNORAG_REVISION=\$\{REVISION\}/);
	assert.match(localRelease, /UNORAG_BUILD_TIME=\$\{BUILD_TIME\}/);
	assert.doesNotMatch(localRelease, /DBOS_APPLICATION_VERSION=lifecycle-v2/);
	assert.doesNotMatch(releaseWorkflow, /DBOS_APPLICATION_VERSION=lifecycle-v2/);
});

test("release signature verification fails closed for missing and invalid signatures", async () => {
	const helper = fileURLToPath(
		new URL("../deploy/compose/scripts/release-env.sh", import.meta.url),
	);
	const directory = await mkdtemp(join(tmpdir(), "unorag-cosign-test-"));
	const binary = join(directory, "cosign");
	const log = join(directory, "cosign.log");
	const image = `ghcr.io/codexlin/unorag@sha256:${"a".repeat(64)}`;
	const command =
		'source "$1"; mk_release_verify_signature UNORAG_WEB_IMAGE "$2"';
	const baseEnvironment = {
		...process.env,
		PATH: `${directory}:${process.env.PATH ?? ""}`,
		UNORAG_VERIFY_IMAGE_SIGNATURES: "true",
		UNORAG_COSIGN_CERTIFICATE_IDENTITY_REGEXP:
			"^https://github.com/codexlin/UnoRAG/.github/workflows/release-images.yml@refs/tags/v.*$",
		UNORAG_COSIGN_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
		COSIGN_LOG: log,
	};

	try {
		await writeFile(
			binary,
			'#!/bin/sh\nprintf "%s\\n" "$*" >> "$COSIGN_LOG"\n[ "$COSIGN_RESULT" != invalid ]\n',
		);
		await chmod(binary, 0o755);

		const valid = spawnSync(
			"bash",
			["-c", command, "signature-test", helper, image],
			{ encoding: "utf8", env: { ...baseEnvironment, COSIGN_RESULT: "valid" } },
		);
		assert.equal(valid.status, 0, valid.stderr);
		const invocation = await readFile(log, "utf8");
		assert.match(invocation, /verify/);
		assert.match(invocation, /--certificate-identity-regexp/);
		assert.match(invocation, /--new-bundle-format=true/);
		assert.ok(invocation.includes(image));

		await writeFile(log, "");
		const legacy = spawnSync(
			"bash",
			["-c", command, "signature-test", helper, image],
			{
				encoding: "utf8",
				env: {
					...baseEnvironment,
					COSIGN_RESULT: "valid",
					UNORAG_COSIGN_NEW_BUNDLE_FORMAT: "false",
					UNORAG_COSIGN_REGISTRY_REFERRERS_MODE: "legacy",
				},
			},
		);
		assert.equal(legacy.status, 0, legacy.stderr);
		assert.match(await readFile(log, "utf8"), /--new-bundle-format=false/);

		const incompatibleLayout = spawnSync(
			"bash",
			["-c", command, "signature-test", helper, image],
			{
				encoding: "utf8",
				env: {
					...baseEnvironment,
					COSIGN_RESULT: "valid",
					UNORAG_COSIGN_NEW_BUNDLE_FORMAT: "true",
					UNORAG_COSIGN_REGISTRY_REFERRERS_MODE: "legacy",
				},
			},
		);
		assert.notEqual(incompatibleLayout.status, 0);
		assert.match(incompatibleLayout.stderr, /storage mode and bundle format/);

		const invalid = spawnSync(
			"bash",
			["-c", command, "signature-test", helper, image],
			{
				encoding: "utf8",
				env: { ...baseEnvironment, COSIGN_RESULT: "invalid" },
			},
		);
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, /signature verification failed/);

		await rm(binary);
		const actuallyMissing = spawnSync(
			"bash",
			["-c", command, "signature-test", helper, image],
			{
				encoding: "utf8",
				env: { ...baseEnvironment, PATH: "/usr/bin:/bin" },
			},
		);
		assert.notEqual(actuallyMissing.status, 0);
		assert.match(actuallyMissing.stderr, /cosign is required/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("release images carry the project license and notice", async () => {
	const dockerfile = await source("deploy/docker/web.Dockerfile");
	assert.match(dockerfile, /COPY LICENSE NOTICE \.\//);
	assert.match(dockerfile, /COPY --chown=unorag:unorag LICENSE NOTICE \.\//);
	assert.match(dockerfile, /ARG UNORAG_VERSION=0\.1\.0-dev/);
	assert.match(dockerfile, /UNORAG_REVISION=\$\{UNORAG_REVISION\}/);
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

test("worker images install production dependencies without retaining a dev layer", async () => {
	const dockerfile = await source("deploy/docker/web.Dockerfile");
	const ci = await source(".github/workflows/ci.yml");
	const release = await source(".github/workflows/release-images.yml");
	assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime-deps/);
	assert.match(dockerfile, /pnpm install --prod --frozen-lockfile/);
	assert.match(dockerfile, /FROM runtime-deps AS ops/);
	assert.match(dockerfile, /FROM runtime-deps AS worker/);
	assert.doesNotMatch(dockerfile, /pnpm prune --prod/);
	for (const workflow of [ci, release]) {
		for (const scope of ["runner", "migrator", "ops", "worker"]) {
			assert.match(
				workflow,
				new RegExp(`cache-from: type=gha,scope=unorag-${scope}`),
			);
			assert.match(
				workflow,
				new RegExp(`cache-to: type=gha,mode=max,scope=unorag-${scope}`),
			);
		}
	}
});

test("fresh registry installs require digest manifests and never build locally", async () => {
	const install = await source("deploy/compose/scripts/install.sh");
	const upgrade = await source("deploy/compose/scripts/upgrade.sh");
	const releaseEnv = await source("deploy/compose/scripts/release-env.sh");
	assert.match(install, /--manifest/);
	assert.match(
		install,
		/mk_release_assert_image UNORAG_WEB_IMAGE "\$WEB_IMAGE" digest/,
	);
	assert.match(install, /pull web migrate-web bootstrap dbos-worker/);
	assert.match(
		install,
		/if \[\[ -n "\$MANIFEST" \]\]; then[\s\S]*?pull[\s\S]*?else[\s\S]*?build/,
	);
	assert.match(releaseEnv, /@sha256:\[a-f0-9\]\{64\}/);
	assert.match(install, /mk_release_resolve_platform "\$MANIFEST"/);
	assert.match(
		install,
		/mk_release_assert_host_platform "\$IMAGE_PLATFORM" "\$ALLOW_PLATFORM_EMULATION"/,
	);
	assert.ok(
		install.indexOf("mk_release_assert_host_platform") <
			install.indexOf("mk_release_write_runtime_pins"),
	);
	assert.match(upgrade, /mk_release_resolve_platform "\$MANIFEST"/);
	assert.ok(
		upgrade.lastIndexOf("mk_release_assert_host_platform") <
			upgrade.lastIndexOf("\ncapture_previous\n"),
	);

	const helper = fileURLToPath(
		new URL("../deploy/compose/scripts/release-env.sh", import.meta.url),
	);
	const valid = spawnSync(
		"bash",
		[
			"-c",
			'source "$1"; mk_release_assert_image TEST "$2" digest',
			"release-env-test",
			helper,
			"repo.example/unorag@sha256:7469c916cdae7d2dc5b7dd460cce2da6c8c5f8feb4933be36b93cc28dd45b053",
		],
		{ encoding: "utf8" },
	);
	assert.equal(valid.status, 0, valid.stderr);

	const tagOnly = spawnSync(
		"bash",
		[
			"-c",
			'source "$1"; mk_release_assert_image TEST "$2" digest',
			"release-env-test",
			helper,
			"repo.example/unorag:v1",
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(tagOnly.status, 0);
	assert.match(tagOnly.stderr, /complete sha256 registry digest/);
});

test("release platform checks fail closed and require an explicit emulation override", () => {
	const helper = fileURLToPath(
		new URL("../deploy/compose/scripts/release-env.sh", import.meta.url),
	);
	const run = (actual, expected, allow = "0") =>
		spawnSync(
			"bash",
			[
				"-c",
				'source "$1"; UNORAG_DOCKER_PLATFORM_OVERRIDE="$2" mk_release_assert_host_platform "$3" "$4"',
				"release-platform-test",
				helper,
				actual,
				expected,
				allow,
			],
			{ encoding: "utf8" },
		);

	const native = run("linux/x86_64", "linux/amd64");
	assert.equal(native.status, 0, native.stderr);

	const mismatch = run("linux/aarch64", "linux/amd64");
	assert.notEqual(mismatch.status, 0);
	assert.match(mismatch.stderr, /release targets linux\/amd64/);
	assert.match(mismatch.stderr, /--allow-platform-emulation/);

	const emulated = run("linux/arm64", "linux/amd64", "1");
	assert.equal(emulated.status, 0, emulated.stderr);
	assert.match(emulated.stderr, /explicit emulation accepted/);

	const invalid = run("linux/riscv64", "linux/amd64");
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /unsupported release platform/);
});

test("runtime image pins retain the release platform across upgrades and rollback", async () => {
	const helper = fileURLToPath(
		new URL("../deploy/compose/scripts/release-env.sh", import.meta.url),
	);
	const directory = await mkdtemp(join(tmpdir(), "unorag-release-platform-"));
	const runtime = join(directory, "runtime.env");
	try {
		await writeFile(
			runtime,
			"UNORAG_WEB_IMAGE=old:web\nUNORAG_DBOS_APPLICATION_VERSION=old\nUNORAG_IMAGE_PLATFORM=\n",
		);
		const result = spawnSync(
			"bash",
			[
				"-c",
				'source "$1"; mk_release_write_runtime_pins "$2" web@sha256:1 migrator@sha256:2 ops@sha256:3 worker@sha256:4 unorag-test linux/amd64',
				"release-pin-test",
				helper,
				runtime,
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const written = await readFile(runtime, "utf8");
		assert.match(written, /^UNORAG_IMAGE_PLATFORM=linux\/amd64$/m);
		assert.match(written, /^UNORAG_DBOS_APPLICATION_VERSION=unorag-test$/m);
		assert.equal((written.match(/^UNORAG_IMAGE_PLATFORM=/gm) ?? []).length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import test from "node:test";

import {
	formatReleaseVersion,
	PRODUCT_BASE_VERSION,
	resolveReleaseInfo,
} from "../../src/lib/release-info";

test("release info defaults to an explicit development identity", () => {
	const release = resolveReleaseInfo({});
	assert.deepEqual(release, {
		version: `${PRODUCT_BASE_VERSION}-dev`,
		channel: "development",
		revision: "development",
		revision_short: "development",
		built_at: null,
		image_digest: null,
		dbos_application_version: null,
	});
	assert.equal(formatReleaseVersion(release), `v${PRODUCT_BASE_VERSION}-dev`);
});

test("release info exposes one immutable release identity", () => {
	const revision = "0123456789abcdef0123456789abcdef01234567";
	const digest = `sha256:${"a".repeat(64)}`;
	const release = resolveReleaseInfo({
		UNORAG_VERSION: "v0.1.0-rc.9",
		UNORAG_REVISION: revision.toUpperCase(),
		UNORAG_BUILD_TIME: "2026-08-11T09:30:00Z",
		UNORAG_BUILD_REF: `ghcr.io/codexlin/unorag@${digest}`,
		UNORAG_DBOS_APPLICATION_VERSION: "unorag-0123456789abcdef",
	});

	assert.deepEqual(release, {
		version: "0.1.0-rc.9",
		channel: "prerelease",
		revision,
		revision_short: revision.slice(0, 12),
		built_at: "2026-08-11T09:30:00.000Z",
		image_digest: digest,
		dbos_application_version: "unorag-0123456789abcdef",
	});
});

test("invalid release metadata fails closed to a development identity", () => {
	const digest = `sha256:${"b".repeat(64)}`;
	const release = resolveReleaseInfo({
		UNORAG_VERSION: "latest",
		UNORAG_REVISION: "branch-main",
		UNORAG_BUILD_TIME: "not-a-date",
		UNORAG_IMAGE_DIGEST: digest.toUpperCase(),
	});

	assert.equal(release.version, `${PRODUCT_BASE_VERSION}-dev`);
	assert.equal(release.channel, "development");
	assert.equal(release.revision, "development");
	assert.equal(release.built_at, null);
	assert.equal(release.image_digest, digest);
});

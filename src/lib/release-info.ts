import packageMetadata from "../../package.json";

export type ReleaseChannel = "stable" | "prerelease" | "development";

export type ReleaseInfo = {
	version: string;
	channel: ReleaseChannel;
	revision: string;
	revision_short: string;
	built_at: string | null;
	image_digest: string | null;
	dbos_application_version: string | null;
};

export const PRODUCT_BASE_VERSION = packageMetadata.version;

const SEMVER_PATTERN =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/i;
const DIGEST_PATTERN = /sha256:[0-9a-f]{64}/i;

function clean(value: string | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized : null;
}

function normalizeVersion(value: string | undefined): string | null {
	const normalized = clean(value)?.replace(/^v(?=\d)/, "") ?? null;
	return normalized && SEMVER_PATTERN.test(normalized) ? normalized : null;
}

function normalizeBuildTime(value: string | undefined): string | null {
	const normalized = clean(value);
	if (!normalized) return null;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function resolveImageDigest(env: Readonly<Record<string, string | undefined>>) {
	for (const candidate of [env.UNORAG_IMAGE_DIGEST, env.UNORAG_BUILD_REF]) {
		const match = clean(candidate)?.match(DIGEST_PATTERN);
		if (match) return match[0].toLowerCase();
	}
	return null;
}

export function resolveReleaseInfo(
	env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseInfo {
	const configuredVersion = normalizeVersion(env.UNORAG_VERSION);
	const configuredRevision = clean(env.UNORAG_REVISION);
	const revision =
		configuredRevision && REVISION_PATTERN.test(configuredRevision)
			? configuredRevision.toLowerCase()
			: "development";
	const version =
		configuredVersion ??
		(revision === "development"
			? `${PRODUCT_BASE_VERSION}-dev`
			: `${PRODUCT_BASE_VERSION}-dev+${revision.slice(0, 12)}`);
	const channel: ReleaseChannel = configuredVersion
		? configuredVersion.includes("-")
			? "prerelease"
			: "stable"
		: "development";

	return {
		version,
		channel,
		revision,
		revision_short:
			revision === "development" ? revision : revision.slice(0, 12),
		built_at: normalizeBuildTime(env.UNORAG_BUILD_TIME),
		image_digest: resolveImageDigest(env),
		dbos_application_version:
			clean(env.UNORAG_DBOS_APPLICATION_VERSION) ?? null,
	};
}

export function formatReleaseVersion(release: Pick<ReleaseInfo, "version">) {
	return `v${release.version}`;
}

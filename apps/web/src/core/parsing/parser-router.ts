import type {
	DocumentAnalysis,
	ParseInput,
	ParserCapabilities,
} from "../contracts";
import type { DurableParserProvider } from "./http-parser-provider";

export type ParserDeploymentPolicy =
	| "strict-private"
	| "private-preferred"
	| "cloud-allowed";

export type ParserRouteRequest = {
	input: ParseInput;
	analysis: DocumentAnalysis;
	deploymentPolicy: ParserDeploymentPolicy;
	externalParserAllowed: boolean;
	preferredProviders?: readonly string[];
};

export type ParserRouteDecision = {
	provider: DurableParserProvider;
	reasons: string[];
};

export class NoParserProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoParserProviderError";
	}
}

export class ParserRouter {
	readonly providers: readonly DurableParserProvider[];

	constructor(providers: readonly DurableParserProvider[]) {
		if (providers.length === 0) {
			throw new Error("ParserRouter requires at least one provider");
		}
		this.providers = providers;
	}

	route(request: ParserRouteRequest): ParserRouteDecision {
		const requestedFormat = inputFormat(request.input);
		const preferred = new Map(
			(request.preferredProviders ?? []).map((name, index) => [
				name.toLowerCase(),
				index,
			]),
		);
		const candidates = this.providers
			.filter((provider) =>
				supportsFormat(provider.capabilities, requestedFormat, request.input),
			)
			.filter(
				(provider) =>
					!provider.capabilities.externalDataProcessing ||
					(request.deploymentPolicy !== "strict-private" &&
						request.externalParserAllowed),
			)
			.filter(
				(provider) => !request.analysis.needsOcr || provider.capabilities.ocr,
			)
			.map((provider) => ({
				provider,
				score:
					signalScore(provider.capabilities, request.analysis) +
					policyScore(provider.capabilities, request.deploymentPolicy) +
					preferenceScore(provider.name, preferred),
			}))
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.provider.name.localeCompare(right.provider.name),
			);

		const selected = candidates[0]?.provider;
		if (!selected) {
			const privacyReason =
				request.deploymentPolicy === "strict-private" ||
				!request.externalParserAllowed
					? "cloud/external providers are forbidden"
					: "no provider has the required capabilities";
			throw new NoParserProviderError(
				`no parser provider for ${requestedFormat}: ${privacyReason}`,
			);
		}

		const reasons = [
			`format:${requestedFormat}`,
			selected.capabilities.externalDataProcessing
				? "processing:external"
				: "processing:private",
		];
		if (request.analysis.needsOcr) reasons.push("signal:ocr");
		if (request.analysis.hasTables) reasons.push("signal:tables");
		if (request.analysis.hasFigures) reasons.push("signal:figures");
		if (request.analysis.complexityScore >= 0.7) reasons.push("signal:complex");
		return { provider: selected, reasons };
	}
}

function inputFormat(input: ParseInput): string {
	const extension = input.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	if (extension) return extension;
	const mimeSubtype = input.mimeType.toLowerCase().split("/")[1]?.split("+")[0];
	return mimeSubtype || "unknown";
}

function supportsFormat(
	capabilities: ParserCapabilities,
	format: string,
	input: ParseInput,
): boolean {
	const values = capabilities.formats.map((value) => value.toLowerCase());
	return (
		values.includes("*") ||
		values.includes(format) ||
		values.includes(`.${format}`) ||
		values.includes(input.mimeType.toLowerCase())
	);
}

function signalScore(
	capabilities: ParserCapabilities,
	analysis: DocumentAnalysis,
): number {
	let score = 0;
	if (analysis.needsOcr && capabilities.ocr) score += 40;
	if (analysis.hasTables && capabilities.tables) score += 15;
	if (analysis.hasFigures && capabilities.figures) score += 10;
	if (analysis.complexityScore >= 0.7 && capabilities.boundingBoxes) score += 5;
	return score;
}

function policyScore(
	capabilities: ParserCapabilities,
	policy: ParserDeploymentPolicy,
): number {
	if (!capabilities.externalDataProcessing) return 20;
	return policy === "cloud-allowed" ? 10 : -10;
}

function preferenceScore(
	name: string,
	preferred: ReadonlyMap<string, number>,
): number {
	const index = preferred.get(name.toLowerCase());
	return index === undefined ? 0 : Math.max(1, 10 - index);
}

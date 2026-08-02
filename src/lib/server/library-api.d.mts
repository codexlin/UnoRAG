export function libraryRequiresReindex(row: {
	documentProfile?: string | null;
	scanHandling?: string | null;
	ingestPolicyVersion?: number | null;
	staleActiveVersions?: number | null;
	requiresReindex?: boolean | null;
	docCount?: number | null;
}): boolean;

export function toApiLibrary(row: {
	ragLibraryId: string;
	name: string;
	description: string | null;
	status: string;
	docCount: number;
	readyCount: number;
	documentProfile?: string | null;
	appliedDocumentProfile?: string | null;
	scanHandling?: string | null;
	ingestPolicyVersion?: number | null;
	staleActiveVersions?: number | null;
	requiresReindex?: boolean | null;
	createdAt: Date;
	updatedAt: Date;
}): Record<string, unknown>;

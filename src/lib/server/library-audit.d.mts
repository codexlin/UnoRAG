export type LibraryAuditRequestContext = {
	requestId: string;
	ipAddress: string | null;
	userAgent: string | null;
};

export type LibraryAuditRow = {
	ragLibraryId: string;
	name: string;
	description?: string | null;
	status: string;
	documentProfile: string;
	scanHandling: string;
	parsePreference: string;
	ingestPolicyVersion: number;
};

export function libraryAuditRequestContext(
	request: Request,
): LibraryAuditRequestContext;

export function libraryCreatedAuditDetails(
	library: LibraryAuditRow,
): Record<string, unknown>;

export function libraryUpdatedAuditDetails(
	before: LibraryAuditRow,
	after: LibraryAuditRow,
): Record<string, unknown> & {
	changed_fields: string[];
	policy_changed: boolean;
};

export function libraryDeleteRequestedAuditDetails(
	library: Pick<LibraryAuditRow, "ragLibraryId" | "name">,
	outcome: {
		immediate: boolean;
		documentCount: number;
		queuedJobs: number;
	},
): Record<string, unknown>;

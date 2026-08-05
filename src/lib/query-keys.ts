export type QueryScope = {
	organizationId: string;
	workspaceId: string;
};

const scopeKey = (scope: QueryScope) =>
	[scope.organizationId, scope.workspaceId] as const;

export const queryKeys = {
	health: (scope: QueryScope) => ["health", ...scopeKey(scope)] as const,
	libraries: (scope: QueryScope) => ["libraries", ...scopeKey(scope)] as const,
	documents: (scope: QueryScope, libraryId: string) =>
		["documents", ...scopeKey(scope), libraryId] as const,
	documentVersions: (
		scope: QueryScope,
		libraryId: string,
		documentId: string,
	) =>
		["document-versions", ...scopeKey(scope), libraryId, documentId] as const,
	documentAcl: (scope: QueryScope, libraryId: string, documentId: string) =>
		["document-acl", ...scopeKey(scope), libraryId, documentId] as const,
	workspaceMembers: (scope: QueryScope) =>
		["workspace-members", ...scopeKey(scope)] as const,
	workspaceInvites: (scope: QueryScope) =>
		["workspace-invites", ...scopeKey(scope)] as const,
	workspaceSettings: (scope: QueryScope) =>
		["workspace-settings", ...scopeKey(scope)] as const,
	operations: (scope: QueryScope) =>
		["operations", ...scopeKey(scope)] as const,
	threads: (scope: QueryScope) => ["threads", ...scopeKey(scope)] as const,
	thread: (scope: QueryScope, threadId: string) =>
		["thread", ...scopeKey(scope), threadId] as const,
} as const;

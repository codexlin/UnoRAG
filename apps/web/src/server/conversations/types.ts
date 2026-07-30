export type ConversationScope = {
	organizationId: string;
	workspaceId: string;
	principalId: string;
};

export type ConversationThreadStatus = "active" | "hidden";

export type ConversationTurnRole = "system" | "user" | "assistant" | "tool";

export type ConversationTurnStatus =
	| "pending"
	| "complete"
	| "failed"
	| "cancelled"
	| "truncated";

export type ConversationCitation = Record<string, unknown>;
export type ConversationDebug = Record<string, unknown>;
export type ConversationUsage = Record<string, unknown>;

export type CreateConversationThreadInput = {
	ragLibraryId?: string | null;
	title?: string | null;
};

export type ListConversationThreadsInput = {
	status?: ConversationThreadStatus;
	limit?: number;
};

export type AppendConversationTurnInput = {
	role: ConversationTurnRole;
	content: string;
	citations?: ConversationCitation[];
	debug?: ConversationDebug | null;
	status?: ConversationTurnStatus;
	usage?: ConversationUsage | null;
};

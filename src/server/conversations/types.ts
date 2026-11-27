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
	sessionId?: string | null;
	ragLibraryId?: string | null;
	title?: string | null;
};

export type ConversationThreadCursor = {
	/** Exact UTC ISO-8601 string (preserving PostgreSQL microseconds) or Date. */
	updatedAt: Date | string;
	createdAt: Date | string;
	id: string;
};

export type ListConversationThreadsInput = {
	status?: ConversationThreadStatus;
	limit?: number;
	query?: string;
	/** string = match ragLibraryId; null = unlinked threads; undefined = all libraries */
	libraryId?: string | null;
	cursor?: ConversationThreadCursor;
};

export type AppendConversationTurnInput = {
	role: ConversationTurnRole;
	content: string;
	citations?: ConversationCitation[];
	debug?: ConversationDebug | null;
	status?: ConversationTurnStatus;
	usage?: ConversationUsage | null;
};

export type CreateConversationThreadWithTurnsInput =
	CreateConversationThreadInput & {
		turns: AppendConversationTurnInput[];
	};

export type AppendConversationExchangeInput = {
	user: AppendConversationTurnInput;
	assistant: AppendConversationTurnInput;
};

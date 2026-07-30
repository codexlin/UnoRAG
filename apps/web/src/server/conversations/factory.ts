import "server-only";

import { getDatabase } from "@/db";

import { ConversationRepository } from "./repository";

export function createConversationRepository(): ConversationRepository {
	return new ConversationRepository(getDatabase());
}

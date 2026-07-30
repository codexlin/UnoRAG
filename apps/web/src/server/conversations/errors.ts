export class ConversationThreadNotFoundError extends Error {
	constructor() {
		super("conversation thread not found");
		this.name = "ConversationThreadNotFoundError";
	}
}

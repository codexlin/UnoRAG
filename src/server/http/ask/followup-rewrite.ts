import type { StructuredOutputAdapter } from "@/core/ai";
import type { AskHistoryMessage, QueryRewrite } from "@/core/ask-graph";
import {
	CLARIFICATION_TTL_MS,
	clarificationSelection,
	groundFollowupQuestion,
	latestClarification,
	type PendingClarification,
} from "@/core/ask-graph/clarification";
import {
	hasFollowupReference,
	isSelfContainedFollowupQuestion,
} from "@/core/ask-graph/nodes/rewrite";

type Message = { role: "user" | "assistant"; content: string };
const DANGLING_REFERENCE =
	/^(?:(?:请|帮我|麻烦|再|核对|查一下|确认|告诉我)\s*)*(?:它|他们|她们|前者|后者|上述|该(?:方案|文件|合同)|这(?:个|份)|那(?:个|份))|^(?:(?:when|where|why|how|what|does|is|can|will|would|could|should)\b[\w\s]{0,24}\b)(?:it|its|they|their|that|this)\b/iu;
const DESCRIBED_DOCUMENT_ZH =
	/^(?:(?:请|帮我|麻烦|再|核对|查一下|确认|告诉我)\s*)*[这那]份\s*(《[^》\n]{2,120}》|[^\n，,。！？?：:的]{2,60}(?:报告|合同|协议|手册|方案|规程|制度|政策|清单|通知|规范|指南))(?=[的中里内上，,：:])/u;

function hasDanglingReference(question: string): boolean {
	const text = question.trim();
	const described = DESCRIBED_DOCUMENT_ZH.exec(text);
	// A source description is retrieval input, not proof of a unique document.
	// Keep evidence/identity checks in the ordinary authorized retrieval path.
	return (
		DANGLING_REFERENCE.test(text) &&
		!(
			described &&
			!hasFollowupReference(described[1]) &&
			!hasFollowupReference(text.slice(described[0].length))
		)
	);
}

function recentExchanges(history: AskHistoryMessage[]): Message[] {
	const selected: Message[] = [];
	let remaining = 8000;
	for (let i = history.length - 1; i > 0 && selected.length < 6; i -= 2) {
		const user = history[i - 1],
			assistant = history[i];
		if (
			user?.role !== "user" ||
			assistant?.role !== "assistant" ||
			typeof user.content !== "string" ||
			typeof assistant.content !== "string"
		)
			break;
		remaining -= user.content.length + assistant.content.length;
		// Never cut an exchange in half or skip over a newer, missing referent.
		if (remaining < 0) break;
		selected.unshift(
			{ role: "user", content: user.content },
			{ role: "assistant", content: assistant.content },
		);
		// A named, independent question starts a new topic. Earlier subjects are
		// not competing referents; elliptical exchanges still retain their anchor.
		if (isSelfContainedFollowupQuestion(user.content)) break;
	}
	return selected;
}

function clarify(
	subjects: string[] = [],
	pendingClarification?: PendingClarification,
): QueryRewrite {
	return {
		query: "",
		mode: "clarify_reference",
		...(pendingClarification ? { pendingClarification } : {}),
		clarification:
			subjects.length > 1
				? `你指的是${subjects.map((s, i) => `${i + 1}.「${s}」`).join("、")}中的哪一个？`
				: "你指的是哪份资料或哪个对象？请带上名称再问一次。",
	};
}

export async function rewriteFollowup(
	question: string,
	history: AskHistoryMessage[],
	resolve: StructuredOutputAdapter["rewrite"],
): Promise<QueryRewrite> {
	const pending = latestClarification(history);
	const last = history.at(-1);
	// Authorization and graph execution can straddle the expiry boundary.
	if (
		last?.role === "assistant" &&
		last.pending_clarification !== undefined &&
		!pending
	)
		return { ...clarify(), mode: "clarification_expired" };
	const selection = pending && clarificationSelection(question, pending);
	if (pending && selection) {
		if (!selection.subject) return clarify(pending.candidates, pending);
		const query = groundFollowupQuestion(pending.question, selection.subject);
		return {
			query,
			mode: "clarification_resolved",
			plan: { grounded_question: query },
		};
	}
	if (!history.length) {
		// A bare dangling reference can also mean all prior sources were revoked.
		if (hasDanglingReference(question)) return clarify();
		return { query: question, mode: "identity_first_turn" };
	}
	if (isSelfContainedFollowupQuestion(question))
		return { query: question, mode: "identity_self_contained" };
	const messages = recentExchanges(history);
	if (!messages.length) return clarify();
	const output = await resolve({ question, history: messages });
	if (output.resolution === "standalone" && output.subjects.length === 0)
		return hasDanglingReference(question)
			? clarify()
			: { query: question, mode: "identity_self_contained" };
	const subjects = [...new Set(output.subjects)].filter(
		(s) => !/[\r\n]/.test(s) && messages.some((m) => m.content.includes(s)),
	);
	const now = Date.now();
	if (
		output.resolution !== "resolved" ||
		output.subjects.length !== 1 ||
		subjects.length !== 1
	)
		return clarify(
			subjects,
			subjects.length > 1
				? {
						version: 1,
						question,
						candidates: subjects,
						createdAt: now,
						expiresAt: now + CLARIFICATION_TTL_MS,
					}
				: undefined,
		);
	const subject = subjects[0];
	const query = groundFollowupQuestion(question, subject);
	return {
		query,
		mode: "history_resolved",
		plan: { grounded_question: query },
	};
}

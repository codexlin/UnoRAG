import { z } from "zod";

export const CLARIFICATION_TTL_MS = 5 * 60_000;
export const PendingClarificationSchema = z
	.object({
		version: z.literal(1),
		question: z.string().trim().min(1).max(4_000),
		candidates: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
		createdAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().nonnegative(),
	})
	.strict();
export type PendingClarification = z.infer<typeof PendingClarificationSchema>;

export function readPendingClarification(
	value: unknown,
	now = Date.now(),
): PendingClarification | undefined {
	const parsed = PendingClarificationSchema.safeParse(value);
	if (!parsed.success) return;
	const pending = parsed.data;
	if (
		pending.createdAt > now ||
		pending.expiresAt <= now ||
		pending.expiresAt - pending.createdAt > CLARIFICATION_TTL_MS ||
		pending.expiresAt <= pending.createdAt ||
		new Set(pending.candidates).size !== pending.candidates.length
	)
		return;
	return pending;
}

/** Only the last server-authorized exchange may carry an outstanding choice. */
export function latestClarification(
	history: readonly Record<string, unknown>[],
	now = Date.now(),
) {
	const last = history.at(-1);
	return last?.role === "assistant"
		? readPendingClarification(last.pending_clarification, now)
		: undefined;
}

const normalize = (value: string) =>
	value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");

export function clarificationSelection(
	question: string,
	pending: PendingClarification,
): { subject?: string } | null {
	const normalized = normalize(question);
	const explicitChoice = /^(?:我选|选择|选)\s*/u.test(normalized);
	const reply = normalized
		.replace(/^(?:我选|选择|选|就是|是)\s*/u, "")
		.replace(/[。.!！]$/u, "");
	const exact = pending.candidates.filter(
		(candidate) => normalize(candidate) === reply,
	);
	if (exact.length === 1) return { subject: exact[0] };
	const ordinal =
		/^(?:第)?(\d+|[零〇一二三四五六七八九十百千万两]+)(?:个|项|份)?$/u.exec(
			reply,
		);
	if (ordinal) {
		const n = /^\d+$/u.test(ordinal[1])
			? Number(ordinal[1])
			: ["一", "二", "三", "四"].indexOf(ordinal[1]) + 1;
		return { subject: pending.candidates[n - 1] };
	}
	if (pending.candidates.length === 2 && /^(?:前者|后者)$/u.test(reply))
		return { subject: pending.candidates[reply === "前者" ? 0 : 1] };
	if (/^[a-z0-9_-]{1,16}$/iu.test(reply)) {
		const aliases = pending.candidates.filter(
			(candidate) =>
				/(?:^|[\s\p{Script=Han}])([a-z0-9_-]+)$/iu.exec(
					normalize(candidate),
				)?.[1] === reply,
		);
		return { subject: aliases.length === 1 ? aliases[0] : undefined };
	}
	return explicitChoice ? {} : null;
}

export function groundFollowupQuestion(
	question: string,
	subject: string,
): string {
	return /(?<!其)它(?=的)/u.test(question)
		? question.replace(/(?<!其)它(?=的)/u, () => subject)
		: `${subject}：${question}`;
}

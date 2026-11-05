import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CapturedAskGenerationSchema,
	CapturedAskRetrievalSchema,
	evaluationTextDigest,
} from "./ragas-export";

export async function privateEvaluationDirectory(
	root = process.cwd(),
): Promise<string> {
	// Capture files are runtime outputs, never deployment build inputs.
	let directory = resolve(/* turbopackIgnore: true */ root);
	for (const part of [".unorag", "evaluation"]) {
		directory = resolve(directory, part);
		await mkdir(directory, { mode: 0o700 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST")
					throw new Error("cannot create private evaluation directory");
			},
		);
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("private evaluation directory must not be a symlink");
		await chmod(directory, 0o700);
	}
	return directory;
}

export async function writePrivateEvaluationArtifact(
	name: string,
	content: string,
	root = process.cwd(),
): Promise<string> {
	if (Buffer.byteLength(content, "utf8") > 8_000_000)
		throw new Error("private evaluation artifact exceeds byte budget");
	if (!/^[a-zA-Z0-9_.:-]{1,200}\.(json|jsonl)$/.test(name))
		throw new Error("invalid private artifact name");
	const directory = await privateEvaluationDirectory(root);
	const path = resolve(directory, name);
	const temporary = resolve(directory, `.pending-${randomUUID()}`);
	try {
		const handle = await open(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		return path;
	} finally {
		await rm(temporary, { force: true });
	}
}

export type AskRetrievalCaptureInput = Readonly<{
	requestId: string;
	sessionId: string;
	question: string;
	query: string;
	attempt: number;
	citations: readonly Readonly<{ body?: unknown }>[];
}>;

export function isEvaluationCaptureEnabled(
	sessionId: string,
	env = process.env,
): boolean {
	const runId = env.UNORAG_EVAL_CAPTURE_RUN_ID;
	return (
		env.UNORAG_EVAL_CAPTURE_SENSITIVE === "1" &&
		typeof runId === "string" &&
		/^[a-zA-Z0-9_.:-]{1,64}$/.test(runId) &&
		sessionId.length <= 256 &&
		sessionId.startsWith(`unorag-eval-${runId}-`)
	);
}

/** Called on authorized raw retrieval, before policy/Judge. No snippet fallback. */
export async function captureAskRetrieval(
	input: AskRetrievalCaptureInput,
	options: { env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<void> {
	const env = options.env ?? process.env;
	const runId = env.UNORAG_EVAL_CAPTURE_RUN_ID;
	if (env.UNORAG_EVAL_CAPTURE_SENSITIVE !== "1" || !runId) return;
	if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(runId) || input.sessionId.length > 256)
		throw new Error("invalid evaluation capture run ID");
	const prefix = `unorag-eval-${runId}-`;
	if (!input.sessionId.startsWith(prefix)) return;
	const parsed = CapturedAskRetrievalSchema.safeParse({
		schema_version: 1,
		run_id: runId,
		case_id: input.sessionId.slice(prefix.length),
		request_id: input.requestId,
		question_sha256: evaluationTextDigest(input.question),
		retrieved_contexts: input.citations.map((citation) => citation.body),
		retrieval: {
			stage: "ask_base_retrieval",
			complete: true,
			ordered: true,
			query: input.query,
			attempt: input.attempt,
		},
	});
	if (!parsed.success)
		throw new Error("invalid full retrieval capture; no artifact written");
	await writePrivateEvaluationArtifact(
		`capture-${input.requestId}.json`,
		JSON.stringify(parsed.data),
		options.root,
	);
}

type CaptureOptions = { env?: NodeJS.ProcessEnv; root?: string };
const captureStorage = new AsyncLocalStorage<{
	last: AskRetrievalCaptureInput | null;
	options: CaptureOptions;
}>();

export function recordAskRetrieval(input: AskRetrievalCaptureInput): void {
	const capture = captureStorage.getStore();
	if (
		capture &&
		isEvaluationCaptureEnabled(input.sessionId, capture.options.env)
	) {
		capture.last = input;
	}
}

export async function withAskRetrievalCapture<T>(
	operation: () => Promise<T>,
	options: CaptureOptions = {},
): Promise<T> {
	const env = options.env ?? process.env;
	if (
		env.UNORAG_EVAL_CAPTURE_SENSITIVE !== "1" ||
		!env.UNORAG_EVAL_CAPTURE_RUN_ID
	)
		return operation();
	return captureStorage.run({ last: null, options }, async () => {
		const result = await operation();
		const capture = captureStorage.getStore();
		// Missing/failed capture becomes unavailable on export; never changes Ask.
		if (capture?.last)
			await captureAskRetrieval(capture.last, options).catch(() => undefined);
		return result;
	});
}

/** Observe only opted-in streams, preserving the exact model input and final token text. */
export async function* captureAskGenerationStream(
	input: {
		requestId: string;
		sessionId: string;
		question: string;
		context: string;
		history: readonly { content: string }[];
	},
	tokens: AsyncIterable<string>,
	options: CaptureOptions = {},
): AsyncGenerator<string> {
	const env = options.env ?? process.env;
	if (!isEvaluationCaptureEnabled(input.sessionId, env)) {
		yield* tokens;
		return;
	}
	let answer = "";
	let bounded = true;
	for await (const token of tokens) {
		if (bounded && answer.length + token.length <= 32_768) answer += token;
		else {
			bounded = false;
			answer = "";
		}
		yield token;
	}
	if (!bounded) return;
	const runId = env.UNORAG_EVAL_CAPTURE_RUN_ID ?? "";
	const parsed = CapturedAskGenerationSchema.safeParse({
		schema_version: 1,
		run_id: runId,
		case_id: input.sessionId.slice(`unorag-eval-${runId}-`.length),
		request_id: input.requestId,
		question_sha256: evaluationTextDigest(input.question),
		response_sha256: evaluationTextDigest(answer),
		generation_contexts: [
			input.context,
			...input.history.map((item) => item.content),
		].filter((value) => value.trim().length > 0),
	});
	if (!parsed.success) return;
	await writePrivateEvaluationArtifact(
		`generation-${input.requestId}.json`,
		JSON.stringify(parsed.data),
		options.root,
	).catch(() => undefined);
}

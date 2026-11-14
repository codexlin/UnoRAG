"use client";

import {
	Children,
	cloneElement,
	createContext,
	isValidElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { InlineCitation } from "@/components/app/inline-citation";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

type MarkdownAnswerProps = {
	content: string;
	className?: string;
	/** When true, run Shiki highlighting (prefer after stream completes). */
	enhanced?: boolean;
	citations?: UiCitation[];
	onCite?: (citation: UiCitation) => void;
	pending?: boolean;
};

const CITE_RE = /\[(\d+)\]/g;

type AnswerRenderValue = {
	byIndex: Map<number, UiCitation>;
	onCite?: (citation: UiCitation) => void;
	enhanced: boolean;
};
const AnswerRenderContext = createContext<AnswerRenderValue>({
	byIndex: new Map(),
	enhanced: false,
});

function CitationText({ children }: { children: ReactNode }) {
	const { byIndex, onCite } = useContext(AnswerRenderContext);
	return injectCitations(children, byIndex, onCite);
}

// Stable renderer identities preserve focus and selection as stream metadata changes.
const ANSWER_COMPONENTS: Components = {
	p: ({ children }) => (
		<p className="whitespace-pre-wrap">
			<CitationText>{children}</CitationText>
		</p>
	),
	h1: ({ children }) => (
		<h3 className="font-heading mt-5 mb-2 text-lg font-medium first:mt-0">
			<CitationText>{children}</CitationText>
		</h3>
	),
	h2: ({ children }) => (
		<h3 className="font-heading mt-5 mb-2 text-base font-medium first:mt-0">
			<CitationText>{children}</CitationText>
		</h3>
	),
	h3: ({ children }) => (
		<h4 className="mt-3 mb-1 text-[0.95em] font-semibold text-foreground first:mt-0">
			<CitationText>{children}</CitationText>
		</h4>
	),
	ul: ({ children }) => (
		<ul className="ml-5 list-disc space-y-1.5">
			<CitationText>{children}</CitationText>
		</ul>
	),
	ol: ({ children }) => (
		<ol className="ml-5 list-decimal space-y-1.5">
			<CitationText>{children}</CitationText>
		</ol>
	),
	li: ({ children }) => (
		<li className="pl-1">
			<CitationText>{children}</CitationText>
		</li>
	),
	strong: ({ children }) => (
		<strong className="font-semibold text-foreground">
			<CitationText>{children}</CitationText>
		</strong>
	),
	em: ({ children }) => (
		<em>
			<CitationText>{children}</CitationText>
		</em>
	),
	a: ({ children, href }) => (
		<a
			className="text-evidence underline underline-offset-4 hover:decoration-2"
			href={href}
			target="_blank"
			rel="noreferrer"
		>
			{children}
		</a>
	),
	blockquote: ({ children }) => (
		<blockquote className="cite-rail border-border/60 py-1 pl-3 text-muted-foreground">
			<CitationText>{children}</CitationText>
		</blockquote>
	),
	table: ({ children }) => (
		<div className="overflow-x-auto rounded-md border border-border/80 bg-background/60">
			<table className="w-full border-collapse text-left font-mono text-xs">
				{children}
			</table>
		</div>
	),
	th: ({ children }) => (
		<th className="border-b border-border bg-secondary/70 px-2 py-1 font-semibold">
			<CitationText>{children}</CitationText>
		</th>
	),
	td: ({ children }) => (
		<td className="border-b border-border/60 px-2 py-1">
			<CitationText>{children}</CitationText>
		</td>
	),
	pre: function AnswerPre({ children }) {
		const { enhanced } = useContext(AnswerRenderContext);
		const child = Children.toArray(children)[0];
		if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
			return (
				<pre className="max-w-full overflow-x-auto whitespace-pre [overflow-wrap:normal]">
					{children}
				</pre>
			);
		}
		const language = /language-(\w+)/.exec(child.props.className ?? "")?.[1];
		return (
			<CodeBlock
				code={String(child.props.children ?? "").replace(/\n$/, "")}
				language={language ?? "text"}
				enhanced={enhanced}
			/>
		);
	},
	code: ({ children }) => (
		<code className="rounded-sm border border-border/70 bg-muted px-1 py-0.5 font-mono text-[0.85em]">
			{children}
		</code>
	),
};

export function MarkdownAnswer({
	content,
	className,
	enhanced = false,
	citations = [],
	onCite,
	pending = false,
}: MarkdownAnswerProps) {
	const byIndex = useMemo(() => {
		const map = new Map<number, UiCitation>();
		for (const citation of citations) {
			map.set(citation.index, citation);
		}
		return map;
	}, [citations]);

	const renderValue = useMemo(
		() => ({ byIndex, onCite, enhanced }),
		[byIndex, onCite, enhanced],
	);

	return (
		<AnswerRenderContext.Provider value={renderValue}>
			<div
				className={cn(
					"text-answer mt-2 min-w-0 space-y-3.5 text-foreground [overflow-wrap:anywhere]",
					className,
				)}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={ANSWER_COMPONENTS}
				>
					{content}
				</ReactMarkdown>
				{pending ? (
					<span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-evidence/70 align-text-bottom" />
				) : null}
			</div>
		</AnswerRenderContext.Provider>
	);
}

function injectCitations(
	children: ReactNode,
	byIndex: Map<number, UiCitation>,
	onCite?: (citation: UiCitation) => void,
): ReactNode {
	return Children.map(children, (child, index) => {
		if (typeof child === "string") {
			return splitCitationText(child, byIndex, onCite, index);
		}
		if (
			!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(
				child,
			)
		) {
			return child;
		}
		if (child.props.children == null) {
			return child;
		}
		if (
			["code", "a", "pre"].includes(
				child.props.node?.tagName ?? String(child.type),
			)
		)
			return child;
		return cloneElement(child, {
			children: injectCitations(child.props.children, byIndex, onCite),
		});
	});
}

function splitCitationText(
	text: string,
	byIndex: Map<number, UiCitation>,
	onCite: ((citation: UiCitation) => void) | undefined,
	keyPrefix: number,
): ReactNode {
	CITE_RE.lastIndex = 0;
	if (!CITE_RE.test(text)) {
		return text;
	}
	CITE_RE.lastIndex = 0;
	const nodes: ReactNode[] = [];
	let last = 0;
	let match = CITE_RE.exec(text);
	let part = 0;
	while (match) {
		if (match.index > last) {
			nodes.push(text.slice(last, match.index));
		}
		const citeIndex = Number(match[1]);
		const citation = byIndex.get(citeIndex);
		const key = `${keyPrefix}-cite-${part}-${citeIndex}`;
		if (citation && onCite) {
			nodes.push(
				<InlineCitation key={key} citation={citation} onSelect={onCite} />,
			);
		} else if (citation) {
			nodes.push(
				<span
					key={key}
					className="mx-0.5 inline-flex size-4 translate-y-[-1px] items-center justify-center rounded-sm border border-evidence/25 bg-evidence/10 align-middle font-mono text-[10px] font-medium leading-none text-evidence"
				>
					{citeIndex}
				</span>,
			);
		} else {
			nodes.push(match[0]);
		}
		last = match.index + match[0].length;
		part += 1;
		match = CITE_RE.exec(text);
	}
	if (last < text.length) {
		nodes.push(text.slice(last));
	}
	return nodes;
}

function CodeBlock({
	code,
	language,
	enhanced,
}: {
	code: string;
	language: string;
	enhanced: boolean;
}) {
	const [html, setHtml] = useState("");
	const [copied, setCopied] = useState(false);
	const normalizedLanguage = useMemo(
		() => normalizeLanguage(language),
		[language],
	);

	useEffect(() => {
		let cancelled = false;
		if (!enhanced) {
			return;
		}

		import("shiki")
			.then(({ codeToHtml }) =>
				codeToHtml(code, {
					lang: normalizedLanguage,
					theme: "nord",
				}),
			)
			.then((value) => {
				if (!cancelled) {
					setHtml(value);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setHtml("");
				}
			});

		return () => {
			cancelled = true;
		};
	}, [code, enhanced, normalizedLanguage]);

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		} catch {
			setCopied(false);
		}
	}

	return (
		<div className="min-w-0 max-w-full overflow-hidden rounded-md border border-primary/30 bg-[#0b1c24] shadow-sm [overflow-wrap:normal]">
			<div className="flex items-center justify-between border-b border-primary/25 bg-[#0f2a33] px-3 py-1 font-mono text-[11px] tracking-[0.16em] text-[#b8d4dc] uppercase">
				<span>{language || "code"}</span>
				<div className="flex items-center gap-2">
					<span className="text-[10px] opacity-70">
						{enhanced && html ? "shiki" : "plain"}
					</span>
					<button
						type="button"
						onClick={() => void copyCode()}
						className="rounded-sm border border-[#b8d4dc]/35 px-2 py-0.5 text-[10px] tracking-[0.14em] text-[#b8d4dc] uppercase transition hover:bg-[#b8d4dc] hover:text-[#0b1c24]"
					>
						{copied ? "已复制" : "复制"}
					</button>
				</div>
			</div>
			{enhanced && html ? (
				<div
					className="[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_code]:leading-5"
					// Shiki output is trusted (generated locally from code text).
					// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki HTML highlighter
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<pre className="overflow-x-auto p-3">
					<code className="font-mono text-xs leading-5 text-[#d5e8ee]">
						{code}
					</code>
				</pre>
			)}
		</div>
	);
}

function normalizeLanguage(language: string) {
	const aliases: Record<string, string> = {
		py: "python",
		js: "javascript",
		ts: "typescript",
		sh: "bash",
		shell: "bash",
		zsh: "bash",
	};
	return aliases[language.toLowerCase()] ?? language.toLowerCase();
}

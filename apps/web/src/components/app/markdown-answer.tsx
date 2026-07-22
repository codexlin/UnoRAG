"use client";

import {
	Children,
	cloneElement,
	isValidElement,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";

import type { MockCitation } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

type MarkdownAnswerProps = {
	content: string;
	className?: string;
	/** When true, run Shiki highlighting (prefer after stream completes). */
	enhanced?: boolean;
	citations?: MockCitation[];
	onCite?: (citation: MockCitation) => void;
	pending?: boolean;
};

const CITE_RE = /\[(\d+)\]/g;

export function MarkdownAnswer({
	content,
	className,
	enhanced = false,
	citations = [],
	onCite,
	pending = false,
}: MarkdownAnswerProps) {
	const byIndex = useMemo(() => {
		const map = new Map<number, MockCitation>();
		for (const citation of citations) {
			map.set(citation.index, citation);
		}
		return map;
	}, [citations]);

	const wrapText = (nodes: ReactNode) =>
		injectCitations(nodes, byIndex, onCite);

	return (
		<div
			className={cn(
				"mt-2 space-y-3 text-sm leading-7 text-foreground",
				className,
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					p: ({ children }) => (
						<p className="leading-7 whitespace-pre-wrap">
							{wrapText(children)}
						</p>
					),
					ul: ({ children }) => (
						<ul className="ml-5 list-disc space-y-1">{wrapText(children)}</ul>
					),
					ol: ({ children }) => (
						<ol className="ml-5 list-decimal space-y-1">
							{wrapText(children)}
						</ol>
					),
					li: ({ children }) => (
						<li className="pl-1 leading-7">{wrapText(children)}</li>
					),
					strong: ({ children }) => (
						<strong className="font-semibold text-foreground">
							{wrapText(children)}
						</strong>
					),
					em: ({ children }) => <em>{wrapText(children)}</em>,
					a: ({ children, href }) => (
						<a
							className="text-cite underline underline-offset-4 hover:text-cite/80"
							href={href}
							target="_blank"
							rel="noreferrer"
						>
							{wrapText(children)}
						</a>
					),
					blockquote: ({ children }) => (
						<blockquote className="cite-rail border-border/60 py-1 pl-3 text-muted-foreground">
							{wrapText(children)}
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
							{wrapText(children)}
						</th>
					),
					td: ({ children }) => (
						<td className="border-b border-border/60 px-2 py-1">
							{wrapText(children)}
						</td>
					),
					code({ className: codeClassName, children, ...props }) {
						const match = /language-(\w+)/.exec(codeClassName || "");
						const language = match?.[1];
						if (!language) {
							return (
								<code
									className="rounded-sm border border-border/70 bg-muted px-1 py-0.5 font-mono text-[0.85em]"
									{...props}
								>
									{children}
								</code>
							);
						}
						return (
							<CodeBlock
								code={String(children).replace(/\n$/, "")}
								language={language}
								enhanced={enhanced}
							/>
						);
					},
				}}
			>
				{content}
			</ReactMarkdown>
			{pending ? (
				<span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-cite/70 align-text-bottom" />
			) : null}
		</div>
	);
}

function injectCitations(
	children: ReactNode,
	byIndex: Map<number, MockCitation>,
	onCite?: (citation: MockCitation) => void,
): ReactNode {
	return Children.map(children, (child, index) => {
		if (typeof child === "string") {
			return splitCitationText(child, byIndex, onCite, index);
		}
		if (!isValidElement<{ children?: ReactNode }>(child)) {
			return child;
		}
		if (child.props.children == null) {
			return child;
		}
		return cloneElement(child, {
			children: injectCitations(child.props.children, byIndex, onCite),
		});
	});
}

function splitCitationText(
	text: string,
	byIndex: Map<number, MockCitation>,
	onCite: ((citation: MockCitation) => void) | undefined,
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
				<button
					key={key}
					type="button"
					onClick={() => onCite(citation)}
					className="mx-0.5 inline rounded-sm bg-cite/10 px-1 font-mono text-[12px] text-cite underline-offset-2 hover:bg-cite/20 hover:underline"
				>
					[{citeIndex}]
				</button>,
			);
		} else if (citation) {
			nodes.push(
				<span
					key={key}
					className="mx-0.5 inline rounded-sm bg-cite/10 px-1 font-mono text-[12px] text-cite"
				>
					[{citeIndex}]
				</span>,
			);
		} else {
			nodes.push(
				<span key={key} className="font-mono text-muted-foreground">
					[{citeIndex}]
				</span>,
			);
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

		codeToHtml(code, {
			lang: normalizedLanguage,
			theme: "nord",
		})
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
		<div className="overflow-hidden rounded-md border border-primary/30 bg-[#0b1c24] shadow-sm">
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

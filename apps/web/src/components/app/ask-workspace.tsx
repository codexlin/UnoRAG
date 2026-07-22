"use client";

import {
	ChevronRight,
	PanelRightClose,
	PanelRightOpen,
	Send,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, type KeyboardEvent, useMemo, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { askQuestion } from "@/lib/api";
import {
	MOCK_DEMO_TURN,
	MOCK_LIBRARIES,
	type MockCitation,
	type MockTurn,
} from "@/lib/mock-data";
import { cn } from "@/lib/utils";

type LocalTurn = MockTurn & { pending?: boolean; error?: string };

export function AskWorkspace() {
	const [libraryId, setLibraryId] = useState(MOCK_LIBRARIES[0]?.id ?? "");
	const [input, setInput] = useState("");
	const [sessionId, setSessionId] = useState<string | undefined>();
	const [turns, setTurns] = useState<LocalTurn[]>([]);
	const [activeCitation, setActiveCitation] = useState<MockCitation | null>(
		null,
	);
	const [drawerOpen, setDrawerOpen] = useState(true);

	const library = useMemo(
		() => MOCK_LIBRARIES.find((item) => item.id === libraryId) ?? null,
		[libraryId],
	);

	const canAsk = Boolean(library && library.status === "ready");

	async function submitQuestion(question: string) {
		const trimmed = question.trim();
		if (!trimmed || !canAsk) return;

		const pendingId = `pending-${Date.now()}`;
		setTurns((prev) => [
			...prev,
			{
				id: pendingId,
				question: trimmed,
				answer: "",
				citations: [],
				pending: true,
			},
		]);
		setInput("");
		setDrawerOpen(true);

		try {
			const result = await askQuestion({
				question: trimmed,
				libraryId,
				sessionId,
			});
			setSessionId(result.session_id);
			const next: LocalTurn = {
				id: `turn-${Date.now()}`,
				question: trimmed,
				answer: result.answer,
				citations: result.citations.map((citation) => ({
					id: citation.id,
					index: citation.index,
					title: citation.title,
					page: citation.page ?? undefined,
					snippet: citation.snippet,
					score: citation.score,
				})),
				refused: result.refused,
				refuseReason: result.refuse_reason,
				mode: result.mode,
			};
			setTurns((prev) =>
				prev.map((turn) => (turn.id === pendingId ? next : turn)),
			);
			setActiveCitation(next.citations[0] ?? null);
		} catch {
			const demo: LocalTurn = {
				...MOCK_DEMO_TURN,
				id: `turn-${Date.now()}`,
				question: trimmed,
				answer: `${MOCK_DEMO_TURN.answer}\n\n（API 不可用，已回退本地 mock。）`,
			};
			setTurns((prev) =>
				prev.map((turn) => (turn.id === pendingId ? demo : turn)),
			);
			setActiveCitation(demo.citations[0] ?? null);
		}
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		void submitQuestion(input);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submitQuestion(input);
		}
	}

	return (
		<div className="flex min-h-0 flex-1">
			<section className="flex min-w-0 flex-1 flex-col">
				<div className="flex flex-wrap items-center gap-3 border-b border-border/70 bg-card/40 px-5 py-3">
					<label className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
						<span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
							当前文库
						</span>
						<select
							value={libraryId}
							onChange={(event) => setLibraryId(event.target.value)}
							className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
						>
							{MOCK_LIBRARIES.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name}
									{item.status === "indexing" ? " · 索引中" : ""}
									{item.status === "empty" ? " · 空" : ""}
								</option>
							))}
						</select>
					</label>
					<div className="flex items-center gap-2">
						<span className="font-mono text-[11px] text-muted-foreground">
							{library
								? `${library.readyCount}/${library.docCount} 就绪`
								: "未选择"}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="rounded-md"
							onClick={() => setDrawerOpen((open) => !open)}
						>
							{drawerOpen ? (
								<PanelRightClose data-icon="inline-start" />
							) : (
								<PanelRightOpen data-icon="inline-start" />
							)}
							引用
						</Button>
					</div>
				</div>

				<div className="flex-1 overflow-y-auto px-5 py-6">
					{turns.length === 0 ? (
						<div className="mx-auto flex max-w-xl flex-col gap-4 py-10">
							<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
								Ask desk
							</p>
							<h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
								{canAsk
									? "对着文库提问，答案旁核对出处"
									: library?.status === "empty"
										? "这本文库还是空的"
										: "文库还在整理中"}
							</h2>
							<p className="text-sm leading-6 text-muted-foreground">
								{canAsk
									? "对着文库提问；无命中或相关度过低时会明确拒答，避免瞎猜。API 不可用时回退本地示例。"
									: library?.status === "empty"
										? "先去文库收录几份资料，问答才有据可依。"
										: "索引完成前暂不可提问，可先到文库查看进度。"}
							</p>
							{!canAsk ? (
								<Link
									href="/app/libraries"
									className={cn(
										buttonVariants({ variant: "outline" }),
										"w-fit rounded-md",
									)}
								>
									前往文库
									<ChevronRight data-icon="inline-end" />
								</Link>
							) : (
								<div className="flex flex-wrap gap-2">
									{[
										"病假需要在几天内补交证明？",
										"试用期考核通过标准是什么？",
									].map((sample) => (
										<button
											key={sample}
											type="button"
											onClick={() => setInput(sample)}
											className="rounded-md border border-border/80 bg-card/80 px-3 py-2 text-left text-xs leading-5 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
										>
											{sample}
										</button>
									))}
								</div>
							)}
						</div>
					) : (
						<ul className="mx-auto flex max-w-2xl flex-col gap-6">
							{turns.map((turn) => (
								<li key={turn.id} className="space-y-3">
									<div className="rounded-md border border-border/70 bg-secondary/40 px-4 py-3">
										<p className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
											Question
										</p>
										<p className="mt-1 text-sm leading-6 text-foreground">
											{turn.question}
										</p>
									</div>
									<div className="rounded-md border border-border/80 bg-card/90 px-4 py-4 shadow-sm">
										<p className="font-mono text-[10px] tracking-[0.14em] text-cite uppercase">
											{turn.refused ? "Refused" : "Answer"}
											{turn.mode ? ` · ${turn.mode}` : ""}
										</p>
										{turn.pending ? (
											<p className="mt-2 text-sm text-muted-foreground">
												正在检索并整理依据…
											</p>
										) : (
											<>
												{turn.refused ? (
													<p className="mt-2 font-mono text-[11px] text-survey">
														{turn.refuseReason === "weak_match"
															? "弱相关 · 未调用生成"
															: "无命中 · 未调用生成"}
													</p>
												) : null}
												<p className="mt-2 text-sm leading-7 text-foreground">
													{turn.answer}
												</p>
												{turn.citations.length > 0 ? (
													<div className="mt-4 flex flex-wrap gap-2">
														{turn.citations.map((citation) => (
															<button
																key={citation.id}
																type="button"
																onClick={() => {
																	setActiveCitation(citation);
																	setDrawerOpen(true);
																}}
																className={cn(
																	"rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
																	activeCitation?.id === citation.id
																		? "border-cite/40 bg-cite/10 text-cite"
																		: "border-border bg-background text-muted-foreground hover:text-foreground",
																)}
															>
																[{citation.index}] {citation.title}
															</button>
														))}
													</div>
												) : turn.refused ? (
													<p className="mt-4 font-mono text-[11px] text-muted-foreground">
														无可用引用
													</p>
												) : null}
											</>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
				</div>

				<form
					onSubmit={onSubmit}
					className="border-t border-border/80 bg-card/70 px-5 py-4 backdrop-blur-sm"
				>
					<div className="mx-auto flex max-w-2xl gap-3">
						<textarea
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={onKeyDown}
							disabled={!canAsk}
							rows={2}
							placeholder={
								canAsk
									? "输入问题，Enter 发送 · Shift+Enter 换行"
									: "文库就绪后再提问…"
							}
							className="min-h-[72px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
						/>
						<Button
							type="submit"
							disabled={!canAsk || !input.trim()}
							className="h-auto self-end rounded-md px-3"
						>
							<Send data-icon="inline-start" />
							发送
						</Button>
					</div>
				</form>
			</section>

			<aside
				className={cn(
					"shrink-0 overflow-hidden border-l border-border/80 bg-card/85 backdrop-blur-sm transition-[width,opacity] duration-200",
					drawerOpen ? "w-[320px] opacity-100" : "w-0 opacity-0 border-l-0",
				)}
				aria-hidden={!drawerOpen}
			>
				<div className="flex h-full w-[320px] flex-col">
					<div className="flex h-12 items-center justify-between border-b border-border/70 px-4">
						<div>
							<p className="font-mono text-[10px] tracking-[0.16em] text-cite uppercase">
								Citations
							</p>
							<p className="text-sm font-medium text-foreground">引用抽屉</p>
						</div>
						<button
							type="button"
							onClick={() => setDrawerOpen(false)}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label="关闭引用抽屉"
						>
							<PanelRightClose className="size-4" />
						</button>
					</div>
					<div className="flex-1 overflow-y-auto p-4">
						{activeCitation ? (
							<article className="cite-rail space-y-3 rounded-md bg-background/70 py-3 pr-3">
								<p className="font-mono text-[11px] text-cite">
									[{activeCitation.index}] · {activeCitation.title}
									{activeCitation.page ? ` · ${activeCitation.page}` : ""}
								</p>
								<p className="text-sm leading-6 text-foreground/90">
									{activeCitation.snippet}
								</p>
								<p className="font-mono text-[11px] text-muted-foreground">
									score {activeCitation.score.toFixed(2)}
								</p>
							</article>
						) : (
							<p className="text-sm leading-6 text-muted-foreground">
								发送问题后，这里会列出可核对的原文片段。无命中拒答时保持空白。
							</p>
						)}
					</div>
				</div>
			</aside>
		</div>
	);
}

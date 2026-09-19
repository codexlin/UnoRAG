"use client";

import { Send, Square } from "lucide-react";
import type { FormEventHandler, KeyboardEventHandler, Ref } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type AskComposerProps = {
	canAsk: boolean;
	healthLoading: boolean;
	input: string;
	isStreaming: boolean;
	onCancel: () => void;
	onChange: (value: string, element: HTMLTextAreaElement) => void;
	onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
	onSubmit: FormEventHandler<HTMLFormElement>;
	textareaRef: Ref<HTMLTextAreaElement>;
};

export function AskComposer({
	canAsk,
	healthLoading,
	input,
	isStreaming,
	onCancel,
	onChange,
	onKeyDown,
	onSubmit,
	textareaRef,
}: AskComposerProps) {
	return (
		<form
			onSubmit={onSubmit}
			className="border-t border-border/70 bg-card px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5"
		>
			<div className="mx-auto max-w-4xl">
				<div
					className={cn(
						"flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-sm transition-[border-color,box-shadow]",
						"focus-within:border-cite/45 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cite)_12%,transparent)]",
						!canAsk && "opacity-80",
					)}
				>
					<Textarea
						ref={textareaRef}
						value={input}
						onChange={(event) => onChange(event.target.value, event.target)}
						onKeyDown={onKeyDown}
						disabled={!canAsk || isStreaming}
						rows={1}
						placeholder={
							isStreaming
								? "生成中… 可点击停止"
								: healthLoading
									? "正在检查服务状态…"
									: canAsk
										? "向知识库提问…"
										: "知识库就绪后再提问…"
						}
						className="text-answer max-h-50 min-h-11 flex-1 resize-none border-0 bg-transparent px-0 py-2.5 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
					/>
					{isStreaming ? (
						<Button
							type="button"
							size="icon"
							variant="outline"
							aria-label="停止生成"
							title="停止生成"
							onClick={onCancel}
							className="mb-0.5 size-9 shrink-0 rounded-md border-survey/40 text-survey shadow-sm transition-transform hover:bg-survey/10 active:scale-[0.96]"
						>
							<Square className="size-3.5 fill-current" />
						</Button>
					) : (
						<Button
							type="submit"
							size="icon"
							disabled={!canAsk || !input.trim()}
							aria-label="发送"
							className="mb-0.5 size-9 shrink-0 rounded-md bg-primary text-primary-foreground shadow-sm transition-transform hover:bg-primary/90 active:scale-[0.96] disabled:shadow-none"
						>
							<Send className="size-4" />
						</Button>
					)}
				</div>
				<p className="text-meta mt-2 text-center font-mono tracking-wide text-muted-foreground/60">
					{isStreaming
						? "点击停止按钮取消当前回答"
						: "Enter 发送 · Shift+Enter 换行"}
				</p>
			</div>
		</form>
	);
}

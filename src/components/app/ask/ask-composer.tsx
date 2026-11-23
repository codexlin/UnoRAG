"use client";

import { ArrowUp, Square } from "lucide-react";
import type { FormEventHandler, KeyboardEventHandler, Ref } from "react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@/components/ui/input-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInterfaceText } from "@/lib/i18n/provider";

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
	const t = useInterfaceText();
	return (
		<form
			onSubmit={onSubmit}
			className="bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
		>
			<div className="mx-auto max-w-3xl">
				<InputGroup className="bg-card shadow-sm has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
					<InputGroupTextarea
						ref={textareaRef}
						value={input}
						onChange={(event) => onChange(event.target.value, event.target)}
						onKeyDown={onKeyDown}
						disabled={!canAsk || isStreaming}
						rows={1}
						aria-label={t("向知识库提问", "Ask the knowledge base")}
						placeholder={
							isStreaming
								? t("生成中…", "Generating…")
								: healthLoading
									? t("正在检查服务状态…", "Checking service status…")
									: canAsk
										? t("向知识库提问…", "Ask the knowledge base…")
										: t("知识库就绪后再提问…", "Ask once the library is ready…")
						}
						className="text-answer max-h-50 min-h-16 min-w-0 px-3 py-4"
					/>
					<InputGroupAddon
						align="inline-end"
						className="shrink-0 self-end py-2.5 has-[>button]:mr-0"
					>
						{isStreaming ? (
							<Tooltip>
								<TooltipTrigger
									render={
										<InputGroupButton
											type="button"
											size="icon-sm"
											variant="secondary"
											aria-label={t("停止生成", "Stop generating")}
											onClick={onCancel}
											className="size-11 shrink-0 self-end rounded-lg"
										>
											<Square className="size-3.5 fill-current" aria-hidden />
										</InputGroupButton>
									}
								/>
								<TooltipContent>
									{t("停止生成", "Stop generating")}
								</TooltipContent>
							</Tooltip>
						) : (
							<Tooltip>
								<TooltipTrigger
									render={
										<InputGroupButton
											type="submit"
											size="icon-sm"
											variant={canAsk && input.trim() ? "default" : "ghost"}
											disabled={!canAsk || !input.trim()}
											aria-label={t("发送", "Send")}
											className="size-11 shrink-0 self-end rounded-lg disabled:text-muted-foreground disabled:opacity-100"
										>
											<ArrowUp className="size-4" aria-hidden />
										</InputGroupButton>
									}
								/>
								<TooltipContent>{t("发送", "Send")}</TooltipContent>
							</Tooltip>
						)}
					</InputGroupAddon>
				</InputGroup>
			</div>
		</form>
	);
}

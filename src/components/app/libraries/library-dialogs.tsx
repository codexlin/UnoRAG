"use client";

import { Trash2 } from "lucide-react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ApiDocument, ApiLibrary } from "@/lib/api";

export type LibraryEditorForm = {
	name: string;
	description: string;
	documentProfile: string;
	scanHandling: string;
	parsePreference: string;
	advancedOpen: boolean;
};

type LibraryEditorDialogProps = {
	open: boolean;
	mode: "create" | "edit";
	editingLibrary: ApiLibrary | null;
	form: LibraryEditorForm;
	error: string | null;
	saving: boolean;
	deleting: boolean;
	onOpenChange: (open: boolean) => void;
	onFormChange: (patch: Partial<LibraryEditorForm>) => void;
	onSubmit: () => void;
	onDelete: (library: ApiLibrary) => void;
};

export function LibraryEditorDialog({
	open,
	mode,
	editingLibrary,
	form,
	error,
	saving,
	deleting,
	onOpenChange,
	onFormChange,
	onSubmit,
	onDelete,
}: LibraryEditorDialogProps) {
	const disabled = saving || deleting;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md" showCloseButton={!disabled}>
				<DialogHeader>
					<DialogTitle>
						{mode === "edit" ? "编辑知识库" : "新建知识库"}
					</DialogTitle>
					<DialogDescription>
						{mode === "edit"
							? "修改名称、描述与文档处理预设；更改预设不会自动全量重建。"
							: "填写名称即可创建；可选择文档处理预设。"}
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					<div className="grid gap-1.5">
						<Label htmlFor="library-name">名称</Label>
						<Input
							id="library-name"
							value={form.name}
							onChange={(event) => onFormChange({ name: event.target.value })}
							placeholder="例如：人事制度库"
							maxLength={256}
							disabled={disabled}
							aria-invalid={Boolean(error && !form.name.trim())}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="library-description">描述（可选）</Label>
						<Textarea
							id="library-description"
							value={form.description}
							onChange={(event) =>
								onFormChange({ description: event.target.value })
							}
							placeholder="简要说明此知识库的用途"
							maxLength={2000}
							disabled={disabled}
							className="min-h-20"
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="library-document-profile">文档处理预设</Label>
						<select
							id="library-document-profile"
							className="rounded-md border border-border bg-background px-2 py-2 text-sm"
							value={form.documentProfile}
							disabled={disabled}
							onChange={(event) =>
								onFormChange({ documentProfile: event.target.value })
							}
						>
							<option value="auto">自动</option>
							<option value="general">通用</option>
							<option value="narrative">叙述/长文</option>
							<option value="table_heavy">表格密集</option>
							<option value="regulatory">制度/规章</option>
							<option value="precise_paragraph">精确段落</option>
						</select>
						{mode === "edit" && editingLibrary?.requires_reindex ? (
							<p className="text-xs text-muted-foreground">
								当前库已有文档，且预设与已索引内容不一致；保存后不会自动全量重建，请按需对文档重新索引。
							</p>
						) : mode === "edit" &&
							editingLibrary &&
							form.documentProfile !==
								(editingLibrary.document_profile ?? "auto") &&
							(editingLibrary.doc_count ?? 0) > 0 ? (
							<p className="text-xs text-amber-700 dark:text-amber-400">
								更改预设不会自动重新索引已有文档；新上传/手动重索引将使用新预设。
							</p>
						) : null}
					</div>
					<div className="grid gap-1.5">
						<button
							type="button"
							className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
							onClick={() => onFormChange({ advancedOpen: !form.advancedOpen })}
						>
							{form.advancedOpen ? "收起解析策略" : "解析策略（质量 / 扫描件）"}
						</button>
						{form.advancedOpen ? (
							<div className="grid gap-3 rounded-md border border-border/70 px-3 py-2">
								<div className="grid gap-1.5">
									<Label htmlFor="library-parse-preference">解析质量偏好</Label>
									<select
										id="library-parse-preference"
										className="rounded-md border border-border bg-background px-2 py-2 text-sm"
										value={form.parsePreference}
										disabled={disabled}
										onChange={(event) =>
											onFormChange({ parsePreference: event.target.value })
										}
									>
										<option value="auto">自动识别</option>
										<option value="quality">强制高质量解析</option>
										<option value="local_only">严格不出域（仅本地）</option>
									</select>
									<p className="text-xs text-muted-foreground">
										只表达业务意图：不会选择自建或 302，也不会配置 API Key /
										URL。高质量在部署允许时优先增强解析；严格不出域对本库禁用增强/外部解析。若部署禁止出域而选择高质量，将回退本地并展示降级原因。
									</p>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="library-scan-handling">扫描件处理</Label>
									<select
										id="library-scan-handling"
										className="rounded-md border border-border bg-background px-2 py-2 text-sm"
										value={form.scanHandling}
										disabled={disabled}
										onChange={(event) =>
											onFormChange({ scanHandling: event.target.value })
										}
									>
										<option value="auto">允许扫描件（自动）</option>
										<option value="force_ocr">强制 OCR</option>
										<option value="disabled">仅文本解析（禁用扫描识别）</option>
									</select>
									<p className="text-xs text-muted-foreground">
										对新上传/重索引生效：自动沿用部署默认；仅文本解析不会调用
										OCR 或 MinerU，纯扫描文件会明确失败；强制 OCR
										会覆盖部署默认。更改后需重索引。
									</p>
								</div>
							</div>
						) : null}
					</div>
					{error ? (
						<p className="text-ui rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter
					className={mode === "edit" ? "sm:justify-between" : undefined}
				>
					{mode === "edit" && editingLibrary ? (
						<Button
							type="button"
							variant="destructive"
							className="rounded-md sm:mr-auto"
							disabled={disabled}
							onClick={() => onDelete(editingLibrary)}
						>
							<Trash2 data-icon="inline-start" />
							删除
						</Button>
					) : null}
					<Button
						type="button"
						variant="outline"
						className="rounded-md"
						disabled={disabled}
						onClick={() => onOpenChange(false)}
					>
						取消
					</Button>
					<Button
						type="button"
						className="rounded-md"
						disabled={disabled}
						onClick={onSubmit}
					>
						{saving
							? mode === "edit"
								? "保存中…"
								: "创建中…"
							: mode === "edit"
								? "保存"
								: "创建"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function DeleteDocumentDialog({
	open,
	document,
	busy,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	document: ApiDocument | null;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogTitle>删除文档？</AlertDialogTitle>
					<AlertDialogDescription>
						将清除「{document?.name ?? "该文档"}」的向量与元数据
						{document?.has_file ? "及已落盘原文" : ""}
						，此操作不可恢复。
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={busy}
						onClick={(event) => {
							event.preventDefault();
							onConfirm();
						}}
					>
						{busy ? "删除中…" : "确认删除"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function ReplaceDocumentDialog({
	document,
	file,
	replacing,
	onOpenChange,
	onConfirm,
}: {
	document: ApiDocument | null;
	file: File | null;
	replacing: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog
			open={document != null && file != null}
			onOpenChange={onOpenChange}
		>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogTitle>替换文件？</AlertDialogTitle>
					<AlertDialogDescription>
						将用「{file?.name}」覆盖「{document?.name}
						」并创建新版本。新版本索引成功前继续服务当前活跃版本；成功后原子切换，
						文档 ID 不变。旧版本保留在版本历史中。
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						disabled={replacing}
						onClick={() => onOpenChange(false)}
					>
						取消
					</AlertDialogCancel>
					<AlertDialogAction
						disabled={replacing}
						onClick={(event) => {
							event.preventDefault();
							onConfirm();
						}}
					>
						{replacing ? "替换中…" : "确认替换"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function DeleteLibraryDialog({
	library,
	deleting,
	onOpenChange,
	onConfirm,
}: {
	library: ApiLibrary | null;
	deleting: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog open={library != null} onOpenChange={onOpenChange}>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogTitle>删除知识库？</AlertDialogTitle>
					<AlertDialogDescription>
						将清除「{library?.name ?? "该知识库"}
						」下所有文档的向量、元数据与原文，此操作不可恢复。
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={deleting}
						onClick={(event) => {
							event.preventDefault();
							onConfirm();
						}}
					>
						{deleting ? "删除中…" : "确认删除"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

"use client";

import { ChevronDown, Trash2 } from "lucide-react";

import { HelpTip } from "@/components/app/help-tip";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ApiDocument, ApiLibrary } from "@/lib/api";

const DOCUMENT_PROFILE_OPTIONS = [
	{ value: "auto", label: "自动" },
	{ value: "general", label: "通用" },
	{ value: "narrative", label: "叙述/长文" },
	{ value: "table_heavy", label: "表格密集" },
	{ value: "regulatory", label: "制度/规章" },
	{ value: "precise_paragraph", label: "精确段落" },
];
const PARSE_PREFERENCE_OPTIONS = [
	{ value: "auto", label: "自动识别" },
	{ value: "quality", label: "强制高质量解析" },
	{ value: "local_only", label: "严格不出域（仅本地）" },
];
const SCAN_HANDLING_OPTIONS = [
	{ value: "auto", label: "允许扫描件（自动）" },
	{ value: "force_ocr", label: "强制 OCR" },
	{ value: "disabled", label: "仅文本解析（禁用扫描识别）" },
];

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
			<DialogContent
				className="max-h-[90dvh] overflow-y-auto sm:max-w-md [&>[data-slot=dialog-close]]:size-11"
				showCloseButton={!disabled}
			>
				<DialogHeader>
					<DialogTitle>
						{mode === "edit" ? "编辑知识库" : "新建知识库"}
					</DialogTitle>
				</DialogHeader>
				<div className="grid gap-3">
					<div className="grid gap-1.5">
						<Label htmlFor="library-name">名称</Label>
						<Input
							id="library-name"
							className="h-11"
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
						<Select
							items={DOCUMENT_PROFILE_OPTIONS}
							value={form.documentProfile}
							disabled={disabled}
							onValueChange={(value) => {
								if (value !== null) onFormChange({ documentProfile: value });
							}}
						>
							<SelectTrigger
								id="library-document-profile"
								className="min-h-11 w-full min-w-0"
							>
								<SelectValue className="min-w-0 truncate" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{DOCUMENT_PROFILE_OPTIONS.map((option) => (
										<SelectItem
											key={option.value}
											value={option.value}
											className="min-h-11"
										>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						{mode === "edit" && editingLibrary?.requires_reindex ? (
							<p className="text-sm leading-relaxed text-muted-foreground">
								预设与已索引内容不一致；保存不会自动重建，请按需重索引文档。
							</p>
						) : mode === "edit" &&
							editingLibrary &&
							form.documentProfile !==
								(editingLibrary.document_profile ?? "auto") &&
							(editingLibrary.doc_count ?? 0) > 0 ? (
							<p className="text-sm leading-relaxed text-warning-foreground">
								已有文档不会自动重索引；新上传或手动重索引使用新预设。
							</p>
						) : null}
					</div>
					<Collapsible
						className="grid gap-1.5"
						open={form.advancedOpen}
						onOpenChange={(advancedOpen) => onFormChange({ advancedOpen })}
					>
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									className="h-auto min-h-11 justify-between gap-2 whitespace-normal px-0 text-left font-normal text-muted-foreground"
								/>
							}
						>
							{form.advancedOpen ? "收起解析策略" : "解析策略（质量 / 扫描件）"}
							<ChevronDown
								className={form.advancedOpen ? "size-4 rotate-180" : "size-4"}
								aria-hidden
							/>
						</CollapsibleTrigger>
						<CollapsibleContent
							id="library-parser-settings"
							className="grid gap-4 border-l border-border pl-4"
						>
							<div className="grid gap-1.5">
								<div className="flex items-center gap-1">
									<Label htmlFor="library-parse-preference">解析质量偏好</Label>
									<HelpTip label="解析质量说明">
										高质量解析在部署允许时优先使用增强解析；部署禁止出域时，回退本地并显示降级原因。严格不出域禁用本库的增强及外部解析。
									</HelpTip>
								</div>
								<Select
									items={PARSE_PREFERENCE_OPTIONS}
									value={form.parsePreference}
									disabled={disabled}
									onValueChange={(value) => {
										if (value !== null)
											onFormChange({ parsePreference: value });
									}}
								>
									<SelectTrigger
										id="library-parse-preference"
										className="min-h-11 w-full min-w-0"
									>
										<SelectValue className="min-w-0 truncate" />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{PARSE_PREFERENCE_OPTIONS.map((option) => (
												<SelectItem
													key={option.value}
													value={option.value}
													className="min-h-11"
												>
													{option.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
								{form.parsePreference !== "local_only" ? (
									<p className="text-sm text-muted-foreground">
										可能调用部署允许的外部解析服务。
									</p>
								) : null}
							</div>
							<div className="grid gap-1.5">
								<div className="flex items-center gap-1">
									<Label htmlFor="library-scan-handling">扫描件处理</Label>
									<HelpTip label="扫描件处理说明">
										自动沿用部署默认；仅文本解析不调用 OCR 或
										MinerU，纯扫描文件会失败；强制 OCR 覆盖部署默认。
									</HelpTip>
								</div>
								<Select
									items={SCAN_HANDLING_OPTIONS}
									value={form.scanHandling}
									disabled={disabled}
									onValueChange={(value) => {
										if (value !== null) onFormChange({ scanHandling: value });
									}}
								>
									<SelectTrigger
										id="library-scan-handling"
										className="min-h-11 w-full min-w-0"
									>
										<SelectValue className="min-w-0 truncate" />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{SCAN_HANDLING_OPTIONS.map((option) => (
												<SelectItem
													key={option.value}
													value={option.value}
													className="min-h-11"
												>
													{option.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
								{mode === "edit" && (editingLibrary?.doc_count ?? 0) > 0 ? (
									<p className="text-sm leading-relaxed text-muted-foreground">
										已有文档需重索引后应用新策略。
									</p>
								) : null}
							</div>
						</CollapsibleContent>
					</Collapsible>
					{error ? (
						<p
							role="alert"
							className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
						>
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
							className="h-11 rounded-md sm:mr-auto"
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
						className="h-11 rounded-md"
						disabled={disabled}
						onClick={() => onOpenChange(false)}
					>
						取消
					</Button>
					<Button
						type="button"
						className="h-11 rounded-md"
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
					<AlertDialogCancel className="h-11" disabled={busy}>
						取消
					</AlertDialogCancel>
					<AlertDialogAction
						className="h-11"
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
						多端提交以服务端最后接受的替换为准；目标版本失败时保留当前活跃版本。
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						className="h-11"
						disabled={replacing}
						onClick={() => onOpenChange(false)}
					>
						取消
					</AlertDialogCancel>
					<AlertDialogAction
						className="h-11"
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
					<AlertDialogCancel className="h-11" disabled={deleting}>
						取消
					</AlertDialogCancel>
					<AlertDialogAction
						className="h-11"
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

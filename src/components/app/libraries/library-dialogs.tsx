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
import { useInterfaceText } from "@/lib/i18n/provider";

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
	const t = useInterfaceText();
	const documentProfiles = [
		{ value: "auto", label: t("自动", "Auto") },
		{ value: "general", label: t("通用", "General") },
		{ value: "narrative", label: t("叙述/长文", "Narrative / long-form") },
		{ value: "table_heavy", label: t("表格密集", "Table-heavy") },
		{ value: "regulatory", label: t("制度/规章", "Policies and regulations") },
		{ value: "precise_paragraph", label: t("精确段落", "Precise paragraphs") },
	];
	const parsePreferences = [
		{ value: "auto", label: t("自动识别", "Auto detect") },
		{
			value: "quality",
			label: t("强制高质量解析", "Prefer high-quality parsing"),
		},
		{
			value: "local_only",
			label: t("严格不出域（仅本地）", "Local only (no external processing)"),
		},
	];
	const scanOptions = [
		{
			value: "auto",
			label: t("允许扫描件（自动）", "Handle scans automatically"),
		},
		{ value: "force_ocr", label: t("强制 OCR", "Force OCR") },
		{
			value: "disabled",
			label: t("仅文本解析（禁用扫描识别）", "Text only (disable OCR)"),
		},
	];
	const disabled = saving || deleting;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[90dvh] overflow-y-auto sm:max-w-md [&>[data-slot=dialog-close]]:size-11"
				showCloseButton={!disabled}
			>
				<DialogHeader>
					<DialogTitle>
						{mode === "edit"
							? t("编辑知识库", "Edit library")
							: t("新建知识库", "Create library")}
					</DialogTitle>
				</DialogHeader>
				<div className="grid gap-3">
					<div className="grid gap-1.5">
						<Label htmlFor="library-name">{t("名称", "Name")}</Label>
						<Input
							id="library-name"
							className="h-11"
							value={form.name}
							onChange={(event) => onFormChange({ name: event.target.value })}
							placeholder={t("例如：人事制度库", "e.g. HR policies")}
							maxLength={256}
							disabled={disabled}
							aria-invalid={Boolean(error && !form.name.trim())}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="library-description">
							{t("描述（可选）", "Description (optional)")}
						</Label>
						<Textarea
							id="library-description"
							value={form.description}
							onChange={(event) =>
								onFormChange({ description: event.target.value })
							}
							placeholder={t(
								"简要说明此知识库的用途",
								"Describe what this library is for",
							)}
							maxLength={2000}
							disabled={disabled}
							className="min-h-20"
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="library-document-profile">
							{t("文档处理预设", "Document processing preset")}
						</Label>
						<Select
							items={documentProfiles}
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
									{documentProfiles.map((option) => (
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
								{t(
									"预设与已索引内容不一致；保存不会自动重建，请按需重索引文档。",
									"The preset differs from indexed content. Saving does not rebuild indexes; reindex documents as needed.",
								)}
							</p>
						) : mode === "edit" &&
							editingLibrary &&
							form.documentProfile !==
								(editingLibrary.document_profile ?? "auto") &&
							(editingLibrary.doc_count ?? 0) > 0 ? (
							<p className="text-sm leading-relaxed text-warning-foreground">
								{t(
									"已有文档不会自动重索引；新上传或手动重索引使用新预设。",
									"New uploads and manual reindexes use the new preset. Existing documents are not reindexed automatically.",
								)}
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
							{form.advancedOpen
								? t("收起解析策略", "Hide parsing policy")
								: t(
										"解析策略（质量 / 扫描件）",
										"Parsing policy (quality and scanned files)",
									)}
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
									<Label htmlFor="library-parse-preference">
										{t("解析质量偏好", "Parsing quality")}
									</Label>
									<HelpTip label={t("解析质量说明", "About parsing quality")}>
										{t(
											"高质量解析在部署允许时优先使用增强解析；部署禁止出域时，回退本地并显示降级原因。严格不出域禁用本库的增强及外部解析。",
											"High quality uses enhanced parsing when allowed. Deployments that prevent external processing fall back to local parsing and record the reason. Local only disables enhanced and external parsing for this library.",
										)}
									</HelpTip>
								</div>
								<Select
									items={parsePreferences}
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
											{parsePreferences.map((option) => (
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
										{t(
											"可能调用部署允许的外部解析服务。",
											"May use an external parser allowed by the deployment.",
										)}
									</p>
								) : null}
							</div>
							<div className="grid gap-1.5">
								<div className="flex items-center gap-1">
									<Label htmlFor="library-scan-handling">
										{t("扫描件处理", "Scanned documents")}
									</Label>
									<HelpTip
										label={t("扫描件处理说明", "About scanned documents")}
									>
										{t(
											"自动沿用部署默认；仅文本解析不调用 OCR 或 MinerU，纯扫描文件会失败；强制 OCR 覆盖部署默认。",
											"Auto follows deployment defaults. Text only disables OCR and MinerU; pure scans cannot be parsed. Force OCR overrides the default.",
										)}
									</HelpTip>
								</div>
								<Select
									items={scanOptions}
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
											{scanOptions.map((option) => (
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
										{t(
											"已有文档需重索引后应用新策略。",
											"Reindex existing documents to apply this policy.",
										)}
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
							{t("删除", "Delete")}
						</Button>
					) : null}
					<Button
						type="button"
						variant="outline"
						className="h-11 rounded-md"
						disabled={disabled}
						onClick={() => onOpenChange(false)}
					>
						{t("取消", "Cancel")}
					</Button>
					<Button
						type="button"
						className="h-11 rounded-md"
						disabled={disabled}
						onClick={onSubmit}
					>
						{saving
							? mode === "edit"
								? t("保存中…", "Saving…")
								: t("创建中…", "Creating…")
							: mode === "edit"
								? t("保存", "Save")
								: t("创建", "Create")}
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
	const t = useInterfaceText();
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{t("删除文档？", "Delete document?")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t(
							`将清除「${document?.name ?? "该文档"}」的向量与元数据${document?.has_file ? "及已落盘原文" : ""}，此操作不可恢复。`,
							`This permanently deletes the vectors and metadata${document?.has_file ? " and the original file" : ""} for ${document?.name ?? "this document"}.`,
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel className="h-11" disabled={busy}>
						{t("取消", "Cancel")}
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
						{busy
							? t("删除中…", "Deleting…")
							: t("确认删除", "Confirm deletion")}
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
	const t = useInterfaceText();
	return (
		<AlertDialog
			open={document != null && file != null}
			onOpenChange={onOpenChange}
		>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{t("替换文件？", "Replace file?")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t(
							`将用「${file?.name}」替换「${document?.name}」并创建新版本。索引成功后切换，文档 ID 不变，旧版本保留在历史中。多端提交以服务端最后接受的替换为准；处理失败则保留当前版本。`,
							`Replace “${document?.name}” with “${file?.name}”. The new version goes live after successful indexing. The document ID stays the same, and the old version remains in history. The latest accepted replacement takes precedence; failure leaves the active version unchanged.`,
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						className="h-11"
						disabled={replacing}
						onClick={() => onOpenChange(false)}
					>
						{t("取消", "Cancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						className="h-11"
						disabled={replacing}
						onClick={(event) => {
							event.preventDefault();
							onConfirm();
						}}
					>
						{replacing
							? t("替换中…", "Replacing…")
							: t("确认替换", "Confirm replacement")}
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
	const t = useInterfaceText();
	return (
		<AlertDialog open={library != null} onOpenChange={onOpenChange}>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{t("删除知识库？", "Delete library?")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t(
							`将清除「${library?.name ?? "该知识库"}」下所有文档的向量、元数据与原文，此操作不可恢复。`,
							`This permanently deletes every document's vectors, metadata, and original file in ${library?.name ?? "this library"}.`,
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel className="h-11" disabled={deleting}>
						{t("取消", "Cancel")}
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
						{deleting
							? t("删除中…", "Deleting…")
							: t("确认删除", "Confirm deletion")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

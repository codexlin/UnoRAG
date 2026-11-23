"use client";

import { LoaderCircle, RotateCcw, Search, Shield } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	type ApiDocument,
	type ApiWorkspaceMember,
	fetchDocumentAcl,
	fetchWorkspaceMembers,
	isAbortError,
	reindexDocument,
	updateDocumentAcl,
} from "@/lib/api";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type Props = {
	open: boolean;
	libraryId: string | null;
	doc: ApiDocument | null;
	onOpenChange: (open: boolean) => void;
	onProjected?: (doc: ApiDocument) => void;
};

export function DocumentAclDialog({
	open,
	libraryId,
	doc,
	onOpenChange,
	onProjected,
}: Props) {
	const t = useInterfaceText();
	const id = useId();
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [scope, setScope] = useState<"workspace" | "restricted">("workspace");
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [members, setMembers] = useState<ApiWorkspaceMember[]>([]);
	const [canEdit, setCanEdit] = useState(false);
	const [reload, setReload] = useState(0);
	const [memberSearch, setMemberSearch] = useState("");
	const titleRef = useRef<HTMLHeadingElement>(null);
	const [loadedAcl, setLoadedAcl] = useState<{
		libraryId: string;
		docId: string;
		signal: AbortSignal;
		revision: number;
	} | null>(null);
	const docId = doc?.id;
	const isLoaded = Boolean(
		open &&
			loadedAcl &&
			!loadedAcl.signal.aborted &&
			loadedAcl.libraryId === libraryId &&
			loadedAcl.docId === docId &&
			loadedAcl.revision === reload,
	);

	useEffect(() => {
		setLoadedAcl(null);
		setCanEdit(false);
		setScope("workspace");
		setSelectedIds([]);
		setMembers([]);
		setSaving(false);
		setMemberSearch("");
		if (!open || !libraryId || !docId) return;
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void Promise.all([
			fetchDocumentAcl({
				libraryId,
				docId,
				signal: controller.signal,
			}),
			fetchWorkspaceMembers(controller.signal),
		])
			.then(([acl, memberPayload]) => {
				if (controller.signal.aborted) return;
				setScope(acl.scope);
				setSelectedIds(acl.principal_ids);
				setCanEdit(acl.can_edit);
				setLoadedAcl({
					libraryId,
					docId,
					signal: controller.signal,
					revision: reload,
				});
				setMembers(
					memberPayload.members.filter((item) => item.status === "active"),
				);
			})
			.catch((err) => {
				if (isAbortError(err) || controller.signal.aborted) return;
				setError(
					err instanceof Error
						? err.message
						: t("加载可见性失败", "Failed to load access settings"),
				);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [open, libraryId, docId, reload, t]);
	const visibleMembers = members.filter((member) =>
		`${member.displayName} ${member.email ?? ""}`
			.toLocaleLowerCase()
			.includes(memberSearch.trim().toLocaleLowerCase()),
	);

	function setMemberSelected(userId: string, checked: boolean) {
		setSelectedIds((prev) =>
			checked
				? prev.includes(userId)
					? prev
					: [...prev, userId]
				: prev.filter((id) => id !== userId),
		);
	}

	async function onSave() {
		if (!doc || !isLoaded || !loadedAcl || !canEdit || loading || saving)
			return;
		if (scope === "restricted" && selectedIds.length === 0) {
			setError(t("请至少选择一位可见成员", "Select at least one member."));
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const saved = await updateDocumentAcl({
				libraryId: loadedAcl.libraryId,
				docId: loadedAcl.docId,
				scope,
				principalIds: scope === "workspace" ? [] : selectedIds,
			});
			if (loadedAcl.signal.aborted) return;
			setScope(saved.scope);
			setSelectedIds(saved.principal_ids);
			setCanEdit(saved.can_edit);
			if (saved.projection === "projection_queued") {
				onProjected?.(doc);
				toast.success(
					t(
						`已保存「${doc.name}」可见性，正在投影到检索`,
						`Saved access for "${doc.name}". Updating search index.`,
					),
				);
			} else if (saved.projection === "reindex_required") {
				const result = await reindexDocument({
					libraryId: loadedAcl.libraryId,
					docId: loadedAcl.docId,
				});
				if (loadedAcl.signal.aborted) return;
				onProjected?.(doc);
				toast.success(
					result.accepted || result.status === "processing"
						? t(
								`已保存「${doc.name}」可见性，正在投影到检索`,
								`Saved access for "${doc.name}". Updating search index.`,
							)
						: t(
								`已保存「${doc.name}」可见性并完成投影`,
								`Saved access for "${doc.name}" and updated search index.`,
							),
				);
			} else if (saved.projection === "deferred_to_ingest") {
				toast.success(
					t(
						`已保存「${doc.name}」可见性；当前索引完成后将按新 ACL 生效`,
						`Saved access for "${doc.name}". New ACL will take effect once current indexing finishes.`,
					),
				);
			} else {
				toast.success(
					t(`已保存「${doc.name}」可见性`, `Saved access for "${doc.name}".`),
				);
			}
			onOpenChange(false);
		} catch (err) {
			if (loadedAcl.signal.aborted) return;
			const message =
				err instanceof Error
					? err.message
					: t("保存可见性失败", "Failed to save access settings");
			setError(message);
		} finally {
			if (!loadedAcl.signal.aborted) setSaving(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (saving) return;
				onOpenChange(next);
			}}
		>
			<DialogContent
				className="sm:max-w-lg"
				initialFocus={titleRef}
				showCloseButton={!saving}
			>
				<DialogHeader>
					<DialogTitle
						ref={titleRef}
						tabIndex={-1}
						className="flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-ring"
					>
						<Shield className="size-4 shrink-0" aria-hidden />
						{t("谁可见", "Document access")}
					</DialogTitle>
					<DialogDescription>
						<span className="block text-foreground [overflow-wrap:anywhere]">
							{doc?.name ?? t("文档", "Document")}
						</span>
						{t(
							"设置文档在知识库检索中的可见范围。",
							"Set who can retrieve this document in library search.",
						)}
					</DialogDescription>
				</DialogHeader>

				{loading ? (
					<p
						role="status"
						className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
					>
						<LoaderCircle
							className="size-4 animate-spin motion-reduce:animate-none"
							aria-hidden
						/>
						{t("正在读取文档权限…", "Loading document access…")}
					</p>
				) : !isLoaded ? (
					<div className="space-y-3 py-3">
						<p
							role="alert"
							className="text-sm text-destructive [overflow-wrap:anywhere]"
						>
							{error ?? t("尚未加载可见性", "Access settings not loaded")}
						</p>
						<Button
							type="button"
							variant="outline"
							className="h-11"
							onClick={() => setReload((value) => value + 1)}
						>
							<RotateCcw data-icon="inline-start" aria-hidden />
							{t("重试读取权限", "Retry loading access")}
						</Button>
					</div>
				) : (
					<div className="space-y-4">
						<fieldset className="space-y-2" disabled={!canEdit || saving}>
							<legend
								id={`${id}-scope-heading`}
								className="mb-2 text-sm font-medium"
							>
								{t("文档可见范围", "Visibility scope")}
							</legend>
							<RadioGroup
								aria-labelledby={`${id}-scope-heading`}
								name={`${id}-scope`}
								value={scope}
								disabled={!canEdit || saving}
								onValueChange={(value) => {
									if (value === "workspace" || value === "restricted") {
										setScope(value);
									}
								}}
							>
								<label
									htmlFor={`${id}-scope-workspace`}
									className={cn(
										"flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors motion-reduce:transition-none",
										scope === "workspace"
											? "border-primary/50 bg-muted/50"
											: "border-border hover:bg-muted/30",
									)}
								>
									<RadioGroupItem
										id={`${id}-scope-workspace`}
										value="workspace"
										className="mt-1"
									/>
									<span className="min-w-0">
										<span className="block text-sm font-medium">
											{t("工作区全员", "All workspace members")}
										</span>
										<span className="text-sm leading-relaxed text-muted-foreground">
											{t(
												"本工作区成员均可在检索中看到此文档",
												"Everyone in this workspace can retrieve this document",
											)}
										</span>
									</span>
								</label>
								<label
									htmlFor={`${id}-scope-restricted`}
									className={cn(
										"flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors motion-reduce:transition-none",
										scope === "restricted"
											? "border-primary/50 bg-muted/50"
											: "border-border hover:bg-muted/30",
									)}
								>
									<RadioGroupItem
										id={`${id}-scope-restricted`}
										value="restricted"
										className="mt-1"
									/>
									<span className="min-w-0">
										<span className="block text-sm font-medium">
											{t("仅指定成员", "Selected members only")}
										</span>
										<span className="text-sm leading-relaxed text-muted-foreground">
											{t(
												"仅所选成员可召回；保存权限与完成检索投影是两个状态。",
												"Only selected members can retrieve it. Saving permissions and finishing search projection happen separately.",
											)}
										</span>
									</span>
								</label>
							</RadioGroup>
						</fieldset>

						{scope === "restricted" ? (
							<div className="space-y-2">
								<div className="flex items-baseline justify-between gap-2">
									<h3 className="text-sm font-medium">
										{t("可见成员", "Allowed members")}
									</h3>
									<span className="text-xs text-muted-foreground">
										{t(
											`已选 ${selectedIds.length} 位`,
											`${selectedIds.length} selected`,
										)}
									</span>
								</div>
								<div className="relative">
									<Search
										className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
										aria-hidden
									/>
									<Input
										aria-label={t("搜索可见成员", "Search allowed members")}
										className="h-11 pl-9"
										value={memberSearch}
										onChange={(event) => setMemberSearch(event.target.value)}
									/>
								</div>
								{members.length === 0 ? (
									<p className="text-ui text-muted-foreground">
										{t("暂无可用成员", "No available members")}
									</p>
								) : (
									<ScrollArea className="h-48 rounded-md border border-border/80">
										<ul className="divide-y divide-border/60 p-1">
											{visibleMembers.length === 0 ? (
												<li className="px-3 py-5 text-sm text-muted-foreground">
													{t("没有匹配的成员", "No matching members")}
												</li>
											) : null}
											{visibleMembers.map((member) => {
												const checked = selectedIds.includes(member.userId);
												return (
													<li key={member.userId}>
														<label
															htmlFor={`${id}-member-${member.userId}`}
															className={cn(
																"flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-3 hover:bg-muted/30",
																checked && "bg-muted/50",
															)}
														>
															<Checkbox
																id={`${id}-member-${member.userId}`}
																checked={checked}
																disabled={!canEdit || saving}
																onCheckedChange={(checked) =>
																	setMemberSelected(member.userId, checked)
																}
															/>
															<span className="min-w-0 flex-1">
																<span className="block text-sm [overflow-wrap:anywhere]">
																	{member.displayName}
																</span>
																<span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
																	{member.email ?? member.role}
																</span>
															</span>
														</label>
													</li>
												);
											})}
										</ul>
									</ScrollArea>
								)}
							</div>
						) : null}

						{error ? (
							<p
								role="alert"
								className="text-sm text-destructive [overflow-wrap:anywhere]"
							>
								{error}
							</p>
						) : null}
						{!canEdit ? (
							<p className="text-sm text-muted-foreground">
								{t(
									"需要 editor 及以上权限才能修改",
									"Editor role or higher is required to make changes.",
								)}
							</p>
						) : null}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						className="h-11"
						disabled={saving}
						onClick={() => onOpenChange(false)}
					>
						{t("取消", "Cancel")}
					</Button>
					<Button
						type="button"
						className="h-11"
						aria-busy={saving}
						disabled={!isLoaded || loading || saving || !canEdit}
						onClick={() => void onSave()}
					>
						{saving ? t("保存中…", "Saving…") : t("保存", "Save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

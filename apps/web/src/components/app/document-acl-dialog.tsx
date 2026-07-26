"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [scope, setScope] = useState<"workspace" | "restricted">("workspace");
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [members, setMembers] = useState<ApiWorkspaceMember[]>([]);
	const [canEdit, setCanEdit] = useState(false);

	useEffect(() => {
		if (!open || !libraryId || !doc) return;
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void Promise.all([
			fetchDocumentAcl({
				libraryId,
				docId: doc.id,
				signal: controller.signal,
			}),
			fetchWorkspaceMembers(controller.signal),
		])
			.then(([acl, memberPayload]) => {
				if (controller.signal.aborted) return;
				setScope(acl.scope);
				setSelectedIds(acl.principal_ids);
				setCanEdit(acl.can_edit);
				setMembers(
					memberPayload.members.filter((item) => item.status === "active"),
				);
			})
			.catch((err) => {
				if (isAbortError(err) || controller.signal.aborted) return;
				setError(err instanceof Error ? err.message : "加载可见性失败");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [open, libraryId, doc]);

	function toggleMember(userId: string) {
		setSelectedIds((prev) =>
			prev.includes(userId)
				? prev.filter((id) => id !== userId)
				: [...prev, userId],
		);
	}

	async function onSave() {
		if (!libraryId || !doc || !canEdit) return;
		if (scope === "restricted" && selectedIds.length === 0) {
			setError("请至少选择一位可见成员");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const saved = await updateDocumentAcl({
				libraryId,
				docId: doc.id,
				scope,
				principalIds: scope === "workspace" ? [] : selectedIds,
			});
			setScope(saved.scope);
			setSelectedIds(saved.principal_ids);
			setCanEdit(saved.can_edit);
			if (saved.projection === "reindex_required") {
				const result = await reindexDocument({
					libraryId,
					docId: doc.id,
				});
				onProjected?.(doc);
				toast.success(
					result.accepted || result.status === "processing"
						? `已保存「${doc.name}」可见性，正在投影到检索`
						: `已保存「${doc.name}」可见性并完成投影`,
				);
			} else if (saved.projection === "deferred_to_ingest") {
				toast.success(
					`已保存「${doc.name}」可见性；当前索引完成后将按新 ACL 生效`,
				);
			} else {
				toast.success(`已保存「${doc.name}」可见性`);
			}
			onOpenChange(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : "保存可见性失败";
			setError(message);
			toast.error(message);
		} finally {
			setSaving(false);
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
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>谁可见</DialogTitle>
					<DialogDescription>
						设置「{doc?.name ?? "文档"}」在 Ask 检索中的可见范围。
						默认工作区全员；受限后仅所选成员可召回。
					</DialogDescription>
				</DialogHeader>

				{loading ? (
					<p className="text-ui text-muted-foreground">加载中…</p>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/80 px-3 py-2">
								<input
									type="radio"
									name="doc-acl-scope"
									className="mt-1"
									checked={scope === "workspace"}
									disabled={!canEdit || saving}
									onChange={() => setScope("workspace")}
								/>
								<span>
									<span className="text-ui block font-medium">工作区全员</span>
									<span className="text-meta text-muted-foreground">
										本工作区成员均可在检索中看到此文档
									</span>
								</span>
							</label>
							<label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/80 px-3 py-2">
								<input
									type="radio"
									name="doc-acl-scope"
									className="mt-1"
									checked={scope === "restricted"}
									disabled={!canEdit || saving}
									onChange={() => setScope("restricted")}
								/>
								<span>
									<span className="text-ui block font-medium">仅指定成员</span>
									<span className="text-meta text-muted-foreground">
										仅勾选的成员可召回；保存后将对就绪文档重索引以投影
									</span>
								</span>
							</label>
						</div>

						{scope === "restricted" ? (
							<div className="space-y-2">
								<Label>可见成员</Label>
								{members.length === 0 ? (
									<p className="text-ui text-muted-foreground">暂无可用成员</p>
								) : (
									<ScrollArea className="h-48 rounded-md border border-border/80">
										<ul className="divide-y divide-border/60 p-1">
											{members.map((member) => {
												const checked = selectedIds.includes(member.userId);
												return (
													<li key={member.userId}>
														<label
															className={cn(
																"flex cursor-pointer items-center gap-2 rounded-md px-2 py-2",
																checked && "bg-muted/50",
															)}
														>
															<input
																type="checkbox"
																checked={checked}
																disabled={!canEdit || saving}
																onChange={() => toggleMember(member.userId)}
															/>
															<span className="min-w-0 flex-1">
																<span className="text-ui block truncate">
																	{member.displayName}
																</span>
																<span className="text-meta block truncate text-muted-foreground">
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

						{error ? <p className="text-ui text-destructive">{error}</p> : null}
						{!canEdit ? (
							<p className="text-meta text-muted-foreground">
								需要 editor 及以上权限才能修改
							</p>
						) : null}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={saving}
						onClick={() => onOpenChange(false)}
					>
						取消
					</Button>
					<Button
						type="button"
						disabled={loading || saving || !canEdit}
						onClick={() => void onSave()}
					>
						{saving ? "保存中…" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

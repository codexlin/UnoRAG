"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Can } from "@/components/app/can";
import { useSession } from "@/components/app/session-provider";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Member = {
	userId: string;
	email: string | null;
	displayName: string;
	status: string;
	role: string;
};

type Invite = {
	id: string;
	email: string;
	role: string;
	status: string;
	expiresAt: string;
	inviteUrl?: string;
};

const ROLE_OPTIONS = [
	{ value: "viewer", label: "查看者" },
	{ value: "editor", label: "编辑者" },
	{ value: "admin", label: "管理员" },
] as const;

export function WorkspaceMembersPanel() {
	const { can, identity } = useSession();
	const canManage = can("manageMembers");
	const [members, setMembers] = useState<Member[]>([]);
	const [invites, setInvites] = useState<Invite[]>([]);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("viewer");
	const [error, setError] = useState<string | null>(null);
	const [createdUrl, setCreatedUrl] = useState<string | null>(null);
	const [emailNote, setEmailNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
	const [removing, setRemoving] = useState(false);

	const refresh = useCallback(async () => {
		const membersRes = await fetch("/api/workspace/members");
		if (membersRes.ok) {
			const data = (await membersRes.json()) as { members: Member[] };
			setMembers(data.members);
		}
		if (!canManage) {
			setInvites([]);
			return;
		}
		const invitesRes = await fetch("/api/workspace/invites");
		if (invitesRes.ok) {
			const data = (await invitesRes.json()) as { invites: Invite[] };
			setInvites(data.invites.filter((item) => item.status === "pending"));
		} else {
			setInvites([]);
		}
	}, [canManage]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function createInvite() {
		setBusy(true);
		setError(null);
		setCreatedUrl(null);
		setEmailNote(null);
		setCopied(false);
		const response = await fetch("/api/workspace/invites", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, role, send_email: true }),
		});
		setBusy(false);
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			setError(
				typeof detail?.detail === "string" ? detail.detail : "创建邀请失败",
			);
			return;
		}
		const invite = (await response.json()) as Invite & {
			emailDelivery?: { sent: boolean; provider: string; reason?: string };
		};
		setCreatedUrl(invite.inviteUrl ?? null);
		if (invite.emailDelivery?.sent) {
			setEmailNote("已尝试通过邮件发送（Resend）");
		} else {
			setEmailNote(
				"未配置邮件或发送未成功：请复制下方链接发给对方（默认方式）",
			);
		}
		setEmail("");
		await refresh();
	}

	async function copyUrl() {
		if (!createdUrl) return;
		await navigator.clipboard.writeText(createdUrl);
		setCopied(true);
	}

	async function revoke(inviteId: string) {
		await fetch(`/api/workspace/invites/${inviteId}`, { method: "DELETE" });
		await refresh();
	}

	async function changeRole(userId: string, nextRole: string) {
		const response = await fetch("/api/workspace/members", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ user_id: userId, role: nextRole }),
		});
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			setError(
				typeof detail?.detail === "string" ? detail.detail : "更新角色失败",
			);
			return;
		}
		await refresh();
	}

	async function confirmRemove() {
		if (!removeTarget) return;
		setRemoving(true);
		setError(null);
		const response = await fetch("/api/workspace/members", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ user_id: removeTarget.userId }),
		});
		setRemoving(false);
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			const message =
				typeof detail?.detail === "string" ? detail.detail : "移除成员失败";
			setError(message);
			toast.error(message);
			return;
		}
		toast.success(`已移除「${removeTarget.displayName}」的访问权限`);
		setRemoveTarget(null);
		await refresh();
	}

	return (
		<div className="space-y-5 rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
			<div>
				<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
					Members
				</p>
				<p className="text-ui mt-1 text-muted-foreground">
					邀请以复制链接为主；配置 Resend 后可自动发邮件。
				</p>
			</div>

			<ul className="space-y-2.5">
				{members.map((member) => (
					<li
						key={member.userId}
						className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2 last:border-0"
					>
						<div className="min-w-0">
							<p className="truncate text-sm font-medium">
								{member.displayName}
							</p>
							<p className="truncate font-mono text-xs text-muted-foreground">
								{member.email}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Can
								cap="manageMembers"
								when={member.role !== "owner"}
								fallback={
									<span className="font-mono text-xs text-muted-foreground">
										{member.role}
									</span>
								}
							>
								<select
									className="rounded-md border border-border bg-background px-2 py-1 text-xs"
									value={member.role}
									onChange={(event) =>
										void changeRole(member.userId, event.target.value)
									}
								>
									{ROLE_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</Can>
							<Can
								cap="manageMembers"
								when={
									member.role !== "owner" &&
									member.userId !== identity.principalId
								}
							>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-destructive hover:text-destructive"
									onClick={() => setRemoveTarget(member)}
								>
									移除
								</Button>
							</Can>
						</div>
					</li>
				))}
			</ul>

			<Can
				cap="manageMembers"
				fallback={
					<p className="text-xs text-muted-foreground">
						仅 owner / admin 可邀请成员、改角色与移除成员。
					</p>
				}
			>
				<div className="space-y-3 border-t border-border/60 pt-4">
					<div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
						<div className="space-y-1.5">
							<Label htmlFor="invite-email">邮箱</Label>
							<Input
								id="invite-email"
								type="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								placeholder="colleague@example.com"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="invite-role">角色</Label>
							<select
								id="invite-role"
								className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
								value={role}
								onChange={(event) => setRole(event.target.value)}
							>
								{ROLE_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>
						<div className="flex items-end">
							<Button
								type="button"
								disabled={busy || !email}
								onClick={() => void createInvite()}
							>
								{busy ? "创建中…" : "创建邀请"}
							</Button>
						</div>
					</div>
					{error ? (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}
					{createdUrl ? (
						<div className="space-y-2 rounded-lg bg-muted/40 px-3 py-3">
							{emailNote ? (
								<p className="text-xs text-muted-foreground">{emailNote}</p>
							) : null}
							<p className="break-all font-mono text-xs">{createdUrl}</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={copyUrl}
							>
								{copied ? "已复制" : "复制链接"}
							</Button>
						</div>
					) : null}
					{invites.length > 0 ? (
						<ul className="space-y-2">
							{invites.map((invite) => (
								<li
									key={invite.id}
									className="flex items-center justify-between gap-2 text-xs"
								>
									<span className="truncate font-mono text-muted-foreground">
										{invite.email} · {invite.role}
									</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => void revoke(invite.id)}
									>
										撤销
									</Button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			</Can>

			<AlertDialog
				open={removeTarget != null}
				onOpenChange={(open) => {
					if (!open && !removing) setRemoveTarget(null);
				}}
			>
				<AlertDialogContent size="default">
					<AlertDialogHeader>
						<AlertDialogTitle>移除成员？</AlertDialogTitle>
						<AlertDialogDescription>
							将移除「{removeTarget?.displayName ?? "该成员"}
							」对本工作区的访问权限；其上传的文档仍保留在工作区。不会删除文档、问答记录或审计历史。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={removing}
							onClick={(event) => {
								event.preventDefault();
								void confirmRemove();
							}}
						>
							{removing ? "移除中…" : "确认移除"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

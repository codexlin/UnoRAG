"use client";

import { Copy, RefreshCw, UserMinus, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/components/app/session-provider";
import {
	type SettingsPanelStateChange,
	useSettingsPanelState,
} from "@/components/app/settings/use-settings-panel-state";
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
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
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
import { formatDateTime } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import { roleLabel } from "@/lib/session-types";

type TextPair = readonly [zh: string, en: string];
type InterfaceText = ReturnType<typeof useInterfaceText>;

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
};

type CreatedInvite = Invite & {
	inviteUrl?: string;
	emailDelivery?: { sent: boolean; provider: string; reason?: string };
};

const ROLE_OPTIONS = [
	{ value: "viewer", label: ["查看者", "Viewer"] },
	{ value: "editor", label: ["编辑者", "Editor"] },
	{ value: "admin", label: ["管理员", "Admin"] },
] as const;

const ACTION_ERRORS = {
	invite: ["创建邀请失败", "Failed to create invite"],
	role: ["更新角色失败", "Failed to update role"],
	remove: ["移除成员失败", "Failed to remove member"],
	revoke: ["撤销邀请失败", "Failed to revoke invite"],
} as const satisfies Record<string, TextPair>;

function formatRole(role: string, t: InterfaceText): string {
	switch (role) {
		case "owner":
			return t("所有者", "Owner");
		case "admin":
			return t("管理员", "Admin");
		case "editor":
			return t("编辑者", "Editor");
		case "viewer":
			return t("查看者", "Viewer");
		default:
			return roleLabel(role);
	}
}

function deliveryNote(invite: CreatedInvite): TextPair {
	if (invite.emailDelivery?.sent) {
		return [
			"邮件服务已接受发送请求，不代表已送达；也可复制链接分享。",
			"The email service accepted the request, though delivery is not guaranteed. You can also copy the link to share.",
		];
	}
	const reasons: Record<string, TextPair> = {
		app_base_url_not_configured: [
			"邀请地址未配置，未发送邮件。请复制链接分享。",
			"Invite URL is not configured, so no email was sent. Copy the link to share.",
		],
		not_configured: [
			"邮件服务未配置，未发送邮件。请复制链接分享。",
			"Email service is not configured, so no email was sent. Copy the link to share.",
		],
		"EMAIL_PROVIDER=none": [
			"邮件服务未启用，未发送邮件。请复制链接分享。",
			"Email service is disabled, so no email was sent. Copy the link to share.",
		],
		"RESEND_API_KEY or EMAIL_FROM missing": [
			"邮件服务配置不完整，未发送邮件。请复制链接分享。",
			"Email service configuration is incomplete, so no email was sent. Copy the link to share.",
		],
		copy_link_only: [
			"邀请已创建，请复制链接分享。",
			"Invite created. Copy the link to share.",
		],
	};
	return (
		reasons[invite.emailDelivery?.reason ?? ""] ?? [
			"邮件未发送成功。邀请已创建，请复制链接分享。",
			"Email could not be sent. The invite was created—copy the link to share.",
		]
	);
}

class WorkspaceResponseError extends Error {
	readonly status: number;

	constructor(status: number) {
		super("读取失败");
		this.status = status;
	}
}

async function readList<T>(path: string, field: string, signal: AbortSignal) {
	const response = await fetch(path, { signal, cache: "no-store" });
	if (!response.ok) throw new WorkspaceResponseError(response.status);
	const data = (await response.json()) as Record<string, unknown>;
	if (!Array.isArray(data[field])) throw new Error("列表响应无效");
	return {
		rows: data[field] as T[],
		canManage:
			typeof data.can_manage === "boolean" ? data.can_manage : undefined,
	};
}

export function WorkspaceMembersPanel({
	onStateChange,
}: {
	onStateChange?: SettingsPanelStateChange;
} = {}) {
	const t = useInterfaceText();
	const roleOptions = ROLE_OPTIONS.map((option) => ({
		value: option.value,
		label: t(option.label[0], option.label[1]),
	}));
	const id = useId();
	const { can, identity } = useSession();
	const sessionCanManage = can("manageMembers");
	const [permissionRevoked, setPermissionRevoked] = useState(false);
	const canManage = sessionCanManage && !permissionRevoked;
	const [members, setMembers] = useState<Member[] | null>(null);
	const [invites, setInvites] = useState<Invite[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [membersError, setMembersError] = useState(false);
	const [invitesError, setInvitesError] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("viewer");
	const [error, setError] = useState<string | null>(null);
	const [inviteOpen, setInviteOpen] = useState(false);
	const [discardOpen, setDiscardOpen] = useState(false);
	const [createdInvite, setCreatedInvite] = useState<{
		url: string | null;
		note: TextPair;
	} | null>(null);
	const [pending, setPending] = useState<keyof typeof ACTION_ERRORS | null>(
		null,
	);
	const [copied, setCopied] = useState(false);
	const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);
	const lifetime = useRef<AbortController | null>(null);
	const readRequest = useRef<AbortController | null>(null);
	const writing = useRef(false);
	const permissionRevokedRef = useRef(false);
	const dialogVersion = useRef(0);
	const removeTrigger = useRef<HTMLButtonElement | null>(null);
	const revokeTrigger = useRef<HTMLButtonElement | null>(null);
	const busy = pending !== null;
	const dirty =
		inviteOpen && !createdInvite && (email !== "" || role !== "viewer");
	const sensitive = Boolean(createdInvite?.url);

	useSettingsPanelState(onStateChange, { dirty, busy, sensitive });

	const revokePermission = useCallback(() => {
		permissionRevokedRef.current = true;
		writing.current = false;
		setPending(null);
		setPermissionRevoked(true);
		readRequest.current?.abort();
		dialogVersion.current += 1;
		setLoading(false);
		setMembers(null);
		setInvites(null);
		setMembersError(false);
		setInvitesError(false);
		setCreatedInvite(null);
		setInviteOpen(false);
		setDiscardOpen(false);
		setEmail("");
		setRole("viewer");
		setCopied(false);
		setError(null);
		setRemoveTarget(null);
		setRevokeTarget(null);
	}, []);

	const refresh = useCallback(async () => {
		const active = lifetime.current;
		if (!active || active.signal.aborted) return;
		readRequest.current?.abort();
		const request = new AbortController();
		readRequest.current = request;
		const isCurrent = () => !request.signal.aborted && !active.signal.aborted;
		setLoading(true);
		setMembersError(false);
		setInvitesError(false);
		const loadMembers = async () => {
			try {
				const result = await readList<Member>(
					"/api/workspace/members",
					"members",
					request.signal,
				);
				if (!isCurrent()) return;
				if (result.canManage === false) revokePermission();
				setMembers(result.rows);
			} catch (error) {
				if (!isCurrent()) return;
				if (
					error instanceof WorkspaceResponseError &&
					(error.status === 401 || error.status === 403)
				) {
					revokePermission();
					return;
				}
				setMembersError(true);
			}
		};
		const loadInvites = async () => {
			if (!sessionCanManage || permissionRevokedRef.current) return;
			try {
				const result = await readList<Invite>(
					"/api/workspace/invites",
					"invites",
					request.signal,
				);
				if (!isCurrent()) return;
				if (result.canManage === false) {
					revokePermission();
					return;
				}
				setInvites(result.rows.filter((item) => item.status === "pending"));
			} catch (error) {
				if (!isCurrent()) return;
				if (
					error instanceof WorkspaceResponseError &&
					(error.status === 401 || error.status === 403)
				) {
					revokePermission();
					return;
				}
				setInvitesError(true);
			}
		};
		try {
			await Promise.all([loadMembers(), loadInvites()]);
		} finally {
			if (isCurrent()) setLoading(false);
		}
	}, [sessionCanManage, revokePermission]);

	useEffect(() => {
		if (!identity.workspaceId) return;
		const active = new AbortController();
		lifetime.current = active;
		writing.current = false;
		permissionRevokedRef.current = false;
		setPermissionRevoked(false);
		dialogVersion.current += 1;
		setMembers(null);
		setInvites(null);
		setPending(null);
		setInviteOpen(false);
		setDiscardOpen(false);
		setCreatedInvite(null);
		setEmail("");
		setRole("viewer");
		setCopied(false);
		setError(null);
		setRemoveTarget(null);
		setRevokeTarget(null);
		void refresh();
		return () => {
			active.abort();
			readRequest.current?.abort();
		};
	}, [refresh, identity.workspaceId]);

	function closeInvite() {
		dialogVersion.current += 1;
		setInviteOpen(false);
		setDiscardOpen(false);
		setCreatedInvite(null);
		setEmail("");
		setRole("viewer");
		setCopied(false);
		setError(null);
	}

	async function mutate(
		action: keyof typeof ACTION_ERRORS,
		path: string,
		options: RequestInit,
		onSuccess: (data: unknown) => void,
	) {
		const active = lifetime.current;
		if (
			!canManage ||
			permissionRevokedRef.current ||
			writing.current ||
			!active ||
			active.signal.aborted
		)
			return;
		writing.current = true;
		setPending(action);
		setError(null);
		try {
			const response = await fetch(path, { ...options, signal: active.signal });
			if (active.signal.aborted || permissionRevokedRef.current) return;
			if (response.status === 401 || response.status === 403) {
				revokePermission();
				return;
			}
			const data = await response.json().catch(() => null);
			if (active.signal.aborted || permissionRevokedRef.current) return;
			if (data?.can_manage === false) {
				revokePermission();
				return;
			}
			if (!response.ok) {
				setError(
					typeof data?.detail === "string"
						? data.detail
						: t(ACTION_ERRORS[action][0], ACTION_ERRORS[action][1]),
				);
				return;
			}
			if (action === "invite" && !data) throw new Error("邀请响应无效");
			onSuccess(data);
			void refresh();
		} catch {
			if (!active.signal.aborted && !permissionRevokedRef.current)
				setError(
					t(
						"请求未完成，无法确认最新状态。请刷新列表核对后重试。",
						"Request did not complete, so the latest state could not be confirmed. Refresh the list and try again.",
					),
				);
		} finally {
			if (!active.signal.aborted) {
				writing.current = false;
				setPending(null);
			}
		}
	}

	function createInvite() {
		if (!email.trim() || createdInvite) return;
		void mutate(
			"invite",
			"/api/workspace/invites",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email, role, send_email: true }),
			},
			(data) => {
				const invite = data as CreatedInvite;
				setCreatedInvite({
					url: invite.inviteUrl
						? new URL(invite.inviteUrl, window.location.origin).href
						: null,
					note: deliveryNote(invite),
				});
				setEmail("");
				setRole("viewer");
				setCopied(false);
			},
		);
	}

	async function copyUrl() {
		if (!createdInvite?.url) return;
		const active = lifetime.current;
		const version = dialogVersion.current;
		try {
			await navigator.clipboard.writeText(createdInvite.url);
			if (!active?.signal.aborted && version === dialogVersion.current) {
				setCopied(true);
				setError(null);
			}
		} catch {
			if (!active?.signal.aborted && version === dialogVersion.current)
				setError(
					t(
						"复制失败，请手动选择邀请链接。",
						"Copy failed. Please select the invite link manually.",
					),
				);
		}
	}

	function changeRole(userId: string, nextRole: string) {
		void mutate(
			"role",
			"/api/workspace/members",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ user_id: userId, role: nextRole }),
			},
			() => toast.success(t("成员角色已更新", "Member role updated")),
		);
	}

	function confirmRemove() {
		if (!removeTarget) return;
		void mutate(
			"remove",
			"/api/workspace/members",
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ user_id: removeTarget.userId }),
			},
			() => {
				toast.success(
					t(
						`已移除「${removeTarget.displayName}」的访问权限`,
						`Removed access for ${removeTarget.displayName}`,
					),
				);
				setRemoveTarget(null);
			},
		);
	}

	function confirmRevoke() {
		if (!revokeTarget) return;
		void mutate(
			"revoke",
			`/api/workspace/invites/${revokeTarget.id}`,
			{ method: "DELETE" },
			() => {
				setRevokeTarget(null);
				toast.success(t("邀请已撤销", "Invite revoked"));
			},
		);
	}

	return (
		<section
			id="members"
			aria-labelledby={`${id}-heading`}
			className="min-w-0 space-y-4 text-sm"
		>
			<Dialog
				open={inviteOpen}
				onOpenChange={(open, details) => {
					if (open) {
						setError(null);
						setInviteOpen(true);
					} else if (writing.current) {
						details.cancel();
					} else if (dirty || sensitive) {
						details.cancel();
						setDiscardOpen(true);
					} else closeInvite();
				}}
			>
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
					<h3 id={`${id}-heading`} className="text-base font-medium">
						{t("成员与邀请", "Members and invites")}
					</h3>
					{canManage ? (
						<DialogTrigger
							render={<Button className="h-11 md:h-9" disabled={busy} />}
						>
							<UserPlus className="size-4" aria-hidden />
							{t("邀请成员", "Invite member")}
						</DialogTrigger>
					) : null}
				</div>
				{!canManage ? (
					<p className="text-sm text-muted-foreground">
						{t(
							"当前为只读权限；仅所有者 / 管理员可管理成员与邀请。",
							"Read-only access. Only owners and admins can manage members and invites.",
						)}
					</p>
				) : null}
				{error && !inviteOpen && !removeTarget && !revokeTarget ? (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				) : null}
				{pending === "role" ? (
					<p role="status">{t("正在更新角色…", "Updating role…")}</p>
				) : null}
				<div aria-busy={loading} className="min-w-0">
					{membersError ? (
						<div className="flex flex-wrap items-center gap-2">
							<p role="alert" className="text-destructive">
								{t(
									"成员列表加载失败，请重试。",
									"Failed to load members. Please try again.",
								)}
								{members !== null
									? t(
											" 以下为上次加载的结果。",
											" Showing the last loaded results.",
										)
									: ""}
							</p>
							<Button
								type="button"
								variant="outline"
								className="h-11"
								disabled={loading || busy}
								onClick={() => void refresh()}
							>
								<RefreshCw className="size-4" aria-hidden />
								{t("重试加载成员", "Retry loading members")}
							</Button>
						</div>
					) : null}
					{members === null && !membersError && loading ? (
						<p role="status" className="py-3 text-muted-foreground">
							{t("正在加载成员…", "Loading members…")}
						</p>
					) : null}
					{members?.length === 0 && !membersError && !loading ? (
						<p className="py-3 text-muted-foreground">
							{t("暂无成员", "No members yet")}
						</p>
					) : null}
					{members && members.length > 0 ? (
						<ul
							aria-label={t("工作区成员", "Workspace members")}
							className="divide-y divide-border/60"
						>
							{members.map((member) => (
								<li
									key={member.userId}
									className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
								>
									<div className="min-w-0 flex-1 basis-48">
										<p className="break-words font-medium">
											{member.displayName}
										</p>
										{member.email ? (
											<p className="break-all text-xs text-muted-foreground">
												{member.email}
											</p>
										) : null}
									</div>
									<div className="flex max-w-full flex-wrap items-center gap-2">
										{canManage && member.role !== "owner" ? (
											<Select
												items={roleOptions}
												value={member.role}
												disabled={busy || loading}
												onValueChange={(value) => {
													if (value !== null) changeRole(member.userId, value);
												}}
											>
												<SelectTrigger
													aria-label={t(
														`${member.displayName}的角色`,
														`Role for ${member.displayName}`,
													)}
													className="min-h-11 w-full min-w-0"
												>
													<SelectValue
														placeholder={t("选择角色", "Select role")}
													/>
												</SelectTrigger>
												<SelectContent>
													<SelectGroup>
														{roleOptions.map((option) => (
															<SelectItem
																key={option.value}
																value={option.value}
															>
																{option.label}
															</SelectItem>
														))}
													</SelectGroup>
												</SelectContent>
											</Select>
										) : (
											<span className="text-sm text-muted-foreground">
												{formatRole(member.role, t)}
											</span>
										)}
										{canManage &&
										member.role !== "owner" &&
										member.userId !== identity.principalId ? (
											<Button
												type="button"
												variant="ghost"
												className="h-11 text-destructive hover:text-destructive"
												disabled={busy || loading}
												onClick={(event) => {
													removeTrigger.current = event.currentTarget;
													setError(null);
													setRemoveTarget(member);
												}}
											>
												<UserMinus className="size-4" aria-hidden />
												{t("移除", "Remove")}
											</Button>
										) : null}
									</div>
								</li>
							))}
						</ul>
					) : null}
				</div>
				{canManage ? (
					<div
						className="space-y-2 border-t border-border/60 pt-4"
						aria-busy={loading}
					>
						<h4 className="font-medium">
							{t("待接受邀请", "Pending invites")}
						</h4>
						{invitesError ? (
							<div className="flex flex-wrap items-center gap-2">
								<p role="alert" className="text-destructive">
									{t(
										"邀请列表加载失败，请重试。",
										"Failed to load invites. Please try again.",
									)}
									{invites !== null
										? t(
												" 以下为上次加载的结果。",
												" Showing the last loaded results.",
											)
										: ""}
								</p>
								<Button
									type="button"
									variant="outline"
									className="h-11"
									disabled={loading || busy}
									onClick={() => void refresh()}
								>
									<RefreshCw className="size-4" aria-hidden />
									{t("重试加载邀请", "Retry loading invites")}
								</Button>
							</div>
						) : null}
						{invites === null && !invitesError ? (
							<p role="status" className="text-muted-foreground">
								{t("正在加载邀请…", "Loading invites…")}
							</p>
						) : null}
						{invites?.length === 0 && !invitesError && !loading ? (
							<p className="text-muted-foreground">
								{t("暂无待接受邀请", "No pending invites")}
							</p>
						) : null}
						{invites && invites.length > 0 ? (
							<ul
								aria-label={t("待接受邀请", "Pending invites")}
								className="divide-y divide-border/60"
							>
								{invites.map((invite) => (
									<li
										key={invite.id}
										className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
									>
										<div className="min-w-0 flex-1 basis-48">
											<p className="break-all">{invite.email}</p>
											<p className="text-xs text-muted-foreground">
												{formatRole(invite.role, t)} · {t("到期", "Expires")}{" "}
												{formatDateTime(invite.expiresAt)}
											</p>
										</div>
										<Button
											type="button"
											variant="ghost"
											className="h-11 text-destructive hover:text-destructive"
											disabled={busy || loading}
											onClick={(event) => {
												revokeTrigger.current = event.currentTarget;
												setError(null);
												setRevokeTarget(invite);
											}}
										>
											<X className="size-4" aria-hidden />
											{t("撤销", "Revoke")}
										</Button>
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : null}

				<DialogContent showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>
							{createdInvite
								? t("邀请已创建", "Invite created")
								: t("邀请成员", "Invite member")}
						</DialogTitle>
						<DialogDescription>
							{createdInvite
								? t(
										"邀请链接仅本次可见，关闭后无法再次查看。",
										"This invite link is shown only once and cannot be viewed after closing.",
									)
								: t(
										"创建后将尝试发送邀请邮件。",
										"We'll try to send an invite email after creation.",
									)}
						</DialogDescription>
					</DialogHeader>
					{createdInvite ? (
						<div className="min-w-0 space-y-3">
							<p role="status" className="text-sm">
								{t(...createdInvite.note)}
							</p>
							{createdInvite.url ? (
								<>
									<p className="text-sm text-warning-foreground">
										{t(
											"链接持有者可接受邀请，请仅分享给受邀人。",
											"Anyone with this link can accept the invite. Share it only with the invited person.",
										)}
									</p>
									<p className="select-all break-all font-mono text-xs">
										{createdInvite.url}
									</p>
									<Button
										type="button"
										variant="outline"
										className="h-11"
										onClick={() => void copyUrl()}
									>
										<Copy className="size-4" aria-hidden />
										{copied
											? t("已复制", "Copied")
											: t("复制链接", "Copy link")}
									</Button>
								</>
							) : (
								<p role="alert" className="text-destructive">
									{t(
										"响应未包含邀请链接，请核对邀请列表与邮件状态，勿重复创建。",
										"The response did not include an invite link. Check pending invites and email status before creating another.",
									)}
								</p>
							)}
						</div>
					) : (
						<form
							id={`${id}-invite-form`}
							className="grid gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								createInvite();
							}}
						>
							<div className="space-y-2">
								<Label htmlFor={`${id}-invite-email`}>
									{t("邮箱", "Email")}
								</Label>
								<Input
									id={`${id}-invite-email`}
									type="email"
									required
									autoComplete="email"
									className="h-11"
									value={email}
									disabled={busy}
									onChange={(event) => setEmail(event.target.value)}
									placeholder="colleague@example.com"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor={`${id}-invite-role`}>{t("角色", "Role")}</Label>
								<Select
									items={roleOptions}
									value={role}
									disabled={busy}
									onValueChange={(value) => {
										if (value !== null) setRole(value);
									}}
								>
									<SelectTrigger
										id={`${id}-invite-role`}
										aria-label={t("角色", "Role")}
										className="min-h-11 w-full min-w-0"
									>
										<SelectValue placeholder={t("选择角色", "Select role")} />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{roleOptions.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</div>
						</form>
					)}
					{error ? (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<DialogClose
							disabled={busy}
							render={<Button variant="outline" className="h-11" />}
						>
							{createdInvite ? t("关闭", "Close") : t("取消", "Cancel")}
						</DialogClose>
						{!createdInvite ? (
							<Button
								type="submit"
								form={`${id}-invite-form`}
								className="h-11 min-w-28"
								disabled={busy || !email.trim()}
							>
								<UserPlus className="size-4" aria-hidden />
								{pending === "invite"
									? t("创建中…", "Creating…")
									: t("创建邀请", "Create invite")}
							</Button>
						) : null}
					</DialogFooter>
					<AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{sensitive
										? t("关闭并清除邀请链接？", "Close and clear invite link?")
										: t("放弃本次邀请？", "Discard this invite?")}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{sensitive
										? t(
												"关闭后无法再次查看此链接，已创建的邀请不会撤销。请确认已妥善保存。",
												"You won't be able to view this link again after closing. The invite remains active—make sure you've saved it.",
											)
										: t(
												"尚未创建邀请，关闭后将丢弃已填写的内容。",
												"The invite hasn't been created yet. Closing will discard your input.",
											)}
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel className="h-11">
									{t("继续查看", "Keep viewing")}
								</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									className="h-11"
									onClick={closeInvite}
								>
									{sensitive
										? t("清除并关闭", "Clear and close")
										: t("放弃并关闭", "Discard and close")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={removeTarget !== null}
				onOpenChange={(open, details) => {
					if (!open && writing.current) details.cancel();
					else if (!open) {
						setRemoveTarget(null);
						setError(null);
					}
				}}
			>
				<AlertDialogContent finalFocus={removeTrigger}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("移除成员？", "Remove member?")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(
								`将移除「${removeTarget?.displayName ?? "该成员"}」对本工作区的访问权限。其文档、问答记录与审计历史仍保留。`,
								`Remove workspace access for ${removeTarget?.displayName ?? "this member"}? Their documents, Ask history, and audit records will remain.`,
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error ? (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel className="h-11" disabled={busy}>
							{t("取消", "Cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="h-11"
							disabled={busy}
							onClick={confirmRemove}
						>
							{pending === "remove"
								? t("移除中…", "Removing…")
								: t("确认移除", "Remove member")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={revokeTarget !== null}
				onOpenChange={(open, details) => {
					if (!open && writing.current) details.cancel();
					else if (!open) {
						setRevokeTarget(null);
						setError(null);
					}
				}}
			>
				<AlertDialogContent finalFocus={revokeTrigger}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("撤销邀请？", "Revoke invite?")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(
								`发给「${revokeTarget?.email}」的邀请链接将失效，对方将无法通过此邀请加入工作区。`,
								`The invite link sent to ${revokeTarget?.email} will stop working, and they will no longer be able to join the workspace with it.`,
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error ? (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel className="h-11" disabled={busy}>
							{t("取消", "Cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="h-11"
							disabled={busy}
							onClick={confirmRevoke}
						>
							{pending === "revoke"
								? t("撤销中…", "Revoking…")
								: t("确认撤销", "Revoke invite")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}

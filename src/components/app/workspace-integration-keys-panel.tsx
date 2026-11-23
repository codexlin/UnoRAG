"use client";

import { Copy, EyeOff, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

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
import { formatDateTime } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";

type ServiceKeyRow = {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	library_ids: string[] | null;
	revoked_at: string | null;
	last_used_at: string | null;
	created_at: string;
};

export function WorkspaceIntegrationKeysPanel({
	onStateChange,
}: {
	onStateChange?: SettingsPanelStateChange;
} = {}) {
	const t = useInterfaceText();
	const id = useId();
	const { can, identity } = useSession();
	const sessionCanManage = can("manageMembers");
	const [permissionRevoked, setPermissionRevoked] = useState(false);
	const canManage = sessionCanManage && !permissionRevoked;
	const [keys, setKeys] = useState<ServiceKeyRow[] | null>(null);
	const [loading, setLoading] = useState(canManage);
	const [loadError, setLoadError] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [discardOpen, setDiscardOpen] = useState(false);
	const [created, setCreated] = useState(false);
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const [pending, setPending] = useState<"create" | "revoke" | null>(null);
	const [copied, setCopied] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<ServiceKeyRow | null>(null);
	const lifetime = useRef<AbortController | null>(null);
	const readRequest = useRef<AbortController | null>(null);
	const writing = useRef(false);
	const permissionRevokedRef = useRef(false);
	const dialogVersion = useRef(0);
	const revokeTrigger = useRef<HTMLButtonElement | null>(null);
	const busy = pending !== null;
	const dirty = dialogOpen && !created && name !== "";
	const sensitive = createdKey !== null;

	useSettingsPanelState(onStateChange, { dirty, busy, sensitive });

	const revokePermission = useCallback(() => {
		permissionRevokedRef.current = true;
		writing.current = false;
		setPending(null);
		setPermissionRevoked(true);
		readRequest.current?.abort();
		dialogVersion.current += 1;
		setLoading(false);
		setKeys(null);
		setLoadError(false);
		setCreated(false);
		setCreatedKey(null);
		setDialogOpen(false);
		setDiscardOpen(false);
		setName("");
		setCopied(false);
		setError(null);
		setRevokeTarget(null);
	}, []);

	const refresh = useCallback(async () => {
		const active = lifetime.current;
		if (
			!sessionCanManage ||
			permissionRevokedRef.current ||
			!active ||
			active.signal.aborted
		)
			return;
		readRequest.current?.abort();
		const request = new AbortController();
		readRequest.current = request;
		const isCurrent = () => !request.signal.aborted && !active.signal.aborted;
		setLoading(true);
		setLoadError(false);
		try {
			const response = await fetch("/api/workspace/keys", {
				signal: request.signal,
				cache: "no-store",
			});
			if (!isCurrent()) return;
			if (response.status === 401 || response.status === 403) {
				revokePermission();
				return;
			}
			if (!response.ok) throw new Error("读取失败");
			const data = (await response.json()) as { keys: ServiceKeyRow[] };
			if (!Array.isArray(data.keys)) throw new Error("密钥列表响应无效");
			if (isCurrent()) setKeys(data.keys.filter((item) => !item.revoked_at));
		} catch {
			if (isCurrent()) setLoadError(true);
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
		setKeys(null);
		setLoading(sessionCanManage);
		setLoadError(false);
		setPending(null);
		setDialogOpen(false);
		setDiscardOpen(false);
		setCreated(false);
		setCreatedKey(null);
		setName("");
		setCopied(false);
		setError(null);
		setRevokeTarget(null);
		void refresh();
		return () => {
			active.abort();
			readRequest.current?.abort();
		};
	}, [refresh, sessionCanManage, identity.workspaceId]);

	function closeDialog() {
		dialogVersion.current += 1;
		setDialogOpen(false);
		setDiscardOpen(false);
		setCreated(false);
		setCreatedKey(null);
		setName("");
		setCopied(false);
		setError(null);
	}

	async function mutate(
		action: "create" | "revoke",
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
			if (!response.ok) {
				setError(
					typeof data?.detail === "string"
						? data.detail
						: action === "create"
							? t("创建密钥失败", "Failed to create key")
							: t("吊销失败", "Failed to revoke key"),
				);
				return;
			}
			if (action === "create" && !data) throw new Error("密钥响应无效");
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

	function createKey() {
		if (created) return;
		void mutate(
			"create",
			"/api/workspace/keys",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: name.trim() || t("集成密钥", "Service key"),
					scopes: ["ask", "retrieve"],
				}),
			},
			(data) => {
				const row = data as ServiceKeyRow & { key?: string };
				setCreatedKey(typeof row.key === "string" && row.key ? row.key : null);
				setCreated(true);
				setName("");
				setCopied(false);
			},
		);
	}

	async function copyKey() {
		if (!createdKey) return;
		const active = lifetime.current;
		const version = dialogVersion.current;
		try {
			await navigator.clipboard.writeText(createdKey);
			if (!active?.signal.aborted && version === dialogVersion.current) {
				setCopied(true);
				setError(null);
			}
		} catch {
			if (!active?.signal.aborted && version === dialogVersion.current)
				setError(
					t(
						"复制失败，请手动选择密钥。",
						"Copy failed. Please select the key manually.",
					),
				);
		}
	}

	function confirmRevoke() {
		if (!revokeTarget) return;
		void mutate(
			"revoke",
			`/api/workspace/keys/${revokeTarget.id}`,
			{ method: "DELETE" },
			() => setRevokeTarget(null),
		);
	}

	return (
		<section
			id="integrations"
			aria-labelledby={`${id}-heading`}
			className="min-w-0 space-y-4 text-sm"
		>
			<Dialog
				open={dialogOpen}
				onOpenChange={(open, details) => {
					if (open) {
						setError(null);
						setDialogOpen(true);
					} else if (writing.current) {
						details.cancel();
					} else if (dirty || sensitive) {
						details.cancel();
						setDiscardOpen(true);
					} else closeDialog();
				}}
			>
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
					<h3 id={`${id}-heading`} className="text-base font-medium">
						{t("集成密钥", "Service keys")}
					</h3>
					{canManage ? (
						<DialogTrigger
							render={<Button className="h-11 md:h-9" disabled={busy} />}
						>
							<Plus className="size-4" aria-hidden />
							{t("创建密钥", "Create key")}
						</DialogTrigger>
					) : null}
				</div>
				{!canManage ? (
					<p className="text-sm text-muted-foreground">
						{t(
							"当前无密钥管理权限；仅所有者 / 管理员可查看与管理集成密钥。",
							"You don't have permission to manage keys. Only owners and admins can view and manage service keys.",
						)}
					</p>
				) : (
					<>
						{error && !dialogOpen && !revokeTarget ? (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						) : null}
						<div aria-busy={loading} className="min-w-0">
							{loadError ? (
								<div className="flex flex-wrap items-center gap-2">
									<p role="alert" className="text-destructive">
										{t(
											"密钥列表加载失败，请重试。",
											"Failed to load service keys. Please try again.",
										)}
										{keys !== null
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
										{t("重试加载密钥", "Retry loading keys")}
									</Button>
								</div>
							) : null}
							{keys === null && !loadError ? (
								<p role="status" className="py-3 text-muted-foreground">
									{t("正在加载密钥…", "Loading keys…")}
								</p>
							) : null}
							{keys?.length === 0 && !loadError && !loading ? (
								<p className="py-3 text-muted-foreground">
									{t("暂无有效密钥", "No active keys")}
								</p>
							) : null}
							{keys && keys.length > 0 ? (
								<ul
									aria-label={t("有效集成密钥", "Active service keys")}
									className="divide-y divide-border/60"
								>
									{keys.map((item) => (
										<li
											key={item.id}
											className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
										>
											<div className="min-w-0 flex-1 basis-48">
												<p className="break-words font-medium">{item.name}</p>
												<p className="break-all font-mono text-xs text-muted-foreground">
													{item.prefix}…
													{item.scopes.length > 0
														? ` · ${item.scopes.join(", ")}`
														: ""}
												</p>
												<p className="mt-1 text-xs text-muted-foreground">
													{t("创建", "Created")}{" "}
													{formatDateTime(item.created_at)} ·{" "}
													{item.last_used_at
														? t(
																`最近使用 ${formatDateTime(item.last_used_at)}`,
																`Last used ${formatDateTime(item.last_used_at)}`,
															)
														: t("尚未使用", "Never used")}
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
													setRevokeTarget(item);
												}}
											>
												<KeyRound className="size-4" aria-hidden />
												{t("吊销", "Revoke")}
											</Button>
										</li>
									))}
								</ul>
							) : null}
						</div>
					</>
				)}

				<DialogContent showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>
							{created
								? t("密钥已创建", "Key created")
								: t("创建密钥", "Create key")}
						</DialogTitle>
						<DialogDescription>
							{created
								? t(
										"明文仅本次可见，关闭或离开后无法再次查看。",
										"The plaintext key is shown only once and cannot be viewed after closing or leaving.",
									)
								: t(
										"权限：ask / retrieve（问答与检索）。明文仅创建时显示一次。",
										"Scopes: ask / retrieve. The plaintext key is shown only once upon creation.",
									)}
						</DialogDescription>
					</DialogHeader>
					<p className="text-sm text-warning-foreground">
						{t(
							"请妥善保管密钥，不要放入前端代码、公开仓库或日志。",
							"Store this key securely. Never place it in frontend code, public repositories, or logs.",
						)}
					</p>
					{created ? (
						<div className="min-w-0 space-y-3">
							{createdKey ? (
								<>
									<p className="select-all break-all font-mono text-xs">
										{createdKey}
									</p>
									<Button
										type="button"
										variant="outline"
										className="h-11"
										onClick={() => void copyKey()}
									>
										<Copy className="size-4" aria-hidden />
										{copied ? t("已复制", "Copied") : t("复制密钥", "Copy key")}
									</Button>
								</>
							) : (
								<p role="alert" className="text-destructive">
									{t(
										"密钥已创建，但响应未包含可用明文。请核对列表并吊销该密钥后重新创建。",
										"The key was created, but the response did not include a usable plaintext value. Check the list, revoke that key, and create a new one.",
									)}
								</p>
							)}
						</div>
					) : (
						<form
							id={`${id}-key-form`}
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault();
								createKey();
							}}
						>
							<Label htmlFor={`${id}-key-name`}>{t("名称", "Name")}</Label>
							<Input
								id={`${id}-key-name`}
								className="h-11"
								value={name}
								disabled={busy}
								placeholder={t("例如：客服助手", "e.g., Support assistant")}
								onChange={(event) => setName(event.target.value)}
							/>
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
							{createdKey ? (
								<>
									<EyeOff className="size-4" aria-hidden />
									{t("清除明文", "Clear key")}
								</>
							) : created ? (
								t("关闭", "Close")
							) : (
								t("取消", "Cancel")
							)}
						</DialogClose>
						{!created ? (
							<Button
								type="submit"
								form={`${id}-key-form`}
								className="h-11 min-w-28"
								disabled={busy}
							>
								<Plus className="size-4" aria-hidden />
								{pending === "create"
									? t("创建中…", "Creating…")
									: t("创建密钥", "Create key")}
							</Button>
						) : null}
					</DialogFooter>
					<AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{sensitive
										? t(
												"关闭并清除密钥明文？",
												"Close and clear plaintext key?",
											)
										: t("放弃创建密钥？", "Discard new key?")}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{sensitive
										? t(
												"关闭后无法再次查看明文，已创建的密钥仍然有效。请确认已妥善保存。",
												"You won't be able to view the plaintext key again after closing. The created key remains active—make sure you've saved it.",
											)
										: t(
												"尚未创建密钥，关闭后将丢弃已填写的名称。",
												"The key hasn't been created yet. Closing will discard the entered name.",
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
									onClick={closeDialog}
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
							{t("吊销密钥？", "Revoke key?")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(
								`吊销「${revokeTarget?.name}」后，使用该密钥的集成将失去访问权限。此操作不可撤销。`,
								`After revoking "${revokeTarget?.name}", integrations using this key will lose access. This action cannot be undone.`,
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
								? t("吊销中…", "Revoking…")
								: t("确认吊销", "Revoke key")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}

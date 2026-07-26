"use client";

import { useCallback, useEffect, useState } from "react";

import { Can } from "@/components/app/can";
import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";

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

export function WorkspaceIntegrationKeysPanel() {
	const { can } = useSession();
	const canManage = can("manageMembers");
	const [keys, setKeys] = useState<ServiceKeyRow[]>([]);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(async () => {
		if (!canManage) {
			setKeys([]);
			return;
		}
		const response = await fetch("/api/workspace/keys");
		if (!response.ok) {
			setKeys([]);
			return;
		}
		const data = (await response.json()) as { keys: ServiceKeyRow[] };
		setKeys(data.keys.filter((item) => !item.revoked_at));
	}, [canManage]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function createKey() {
		setBusy(true);
		setError(null);
		setCreatedKey(null);
		setCopied(false);
		const response = await fetch("/api/workspace/keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: name.trim() || "集成密钥",
				scopes: ["ask", "retrieve"],
			}),
		});
		setBusy(false);
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			setError(
				typeof detail?.detail === "string" ? detail.detail : "创建密钥失败",
			);
			return;
		}
		const row = (await response.json()) as ServiceKeyRow & { key?: string };
		setCreatedKey(typeof row.key === "string" ? row.key : null);
		setName("");
		await refresh();
	}

	async function copyKey() {
		if (!createdKey) return;
		await navigator.clipboard.writeText(createdKey);
		setCopied(true);
	}

	async function revoke(keyId: string) {
		setBusy(true);
		setError(null);
		const response = await fetch(`/api/workspace/keys/${keyId}`, {
			method: "DELETE",
		});
		setBusy(false);
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			setError(typeof detail?.detail === "string" ? detail.detail : "吊销失败");
			return;
		}
		await refresh();
	}

	return (
		<div className="space-y-5 rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
			<div>
				<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
					Integration
				</p>
				<p className="text-ui mt-1 text-muted-foreground">
					模式 B 服务密钥：供已有助手调用{" "}
					<span className="font-mono text-xs">/api/v1/retrieve</span> 与{" "}
					<span className="font-mono text-xs">/api/v1/ask</span>
					。明文仅创建时显示一次。
				</p>
			</div>

			<Can
				cap="manageMembers"
				fallback={
					<p className="text-xs text-muted-foreground">
						仅 owner / admin 可管理集成密钥。
					</p>
				}
			>
				<ul className="space-y-2.5">
					{keys.length === 0 ? (
						<li className="text-xs text-muted-foreground">暂无有效密钥</li>
					) : (
						keys.map((item) => (
							<li
								key={item.id}
								className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2 last:border-0"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">{item.name}</p>
									<p className="truncate font-mono text-xs text-muted-foreground">
										{item.prefix}…
										{item.scopes.length > 0
											? ` · ${item.scopes.join(",")}`
											: ""}
									</p>
									<p className="mt-0.5 font-mono text-[0.7rem] text-muted-foreground">
										创建 {formatDateTime(item.created_at)}
										{item.last_used_at
											? ` · 最近使用 ${formatDateTime(item.last_used_at)}`
											: ""}
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => void revoke(item.id)}
								>
									吊销
								</Button>
							</li>
						))
					)}
				</ul>

				<div className="space-y-3 border-t border-border/60 pt-4">
					<div className="grid gap-3 sm:grid-cols-[1fr_auto]">
						<div className="space-y-1.5">
							<Label htmlFor="service-key-name">名称</Label>
							<Input
								id="service-key-name"
								value={name}
								placeholder="例如：客服助手"
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						<div className="flex items-end">
							<Button
								type="button"
								disabled={busy}
								onClick={() => void createKey()}
							>
								创建密钥
							</Button>
						</div>
					</div>

					{createdKey ? (
						<div className="space-y-2 rounded-lg border border-border/70 bg-background/60 px-3 py-3">
							<p className="text-xs text-muted-foreground">
								请立即复制并妥善保存，关闭后无法再次查看明文。
							</p>
							<p className="break-all font-mono text-xs">{createdKey}</p>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => void copyKey()}
							>
								{copied ? "已复制" : "复制密钥"}
							</Button>
						</div>
					) : null}

					{error ? <p className="text-xs text-destructive">{error}</p> : null}
				</div>
			</Can>
		</div>
	);
}

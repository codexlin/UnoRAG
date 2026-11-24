"use client";

import {
	Check,
	Copy,
	Download,
	RefreshCw,
	RotateCcw,
	Search,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

import { HelpTip } from "@/components/app/help-tip";
import {
	CursorPaginationBar,
	LedgerTable,
	LedgerTableSkeleton,
} from "@/components/app/ledger-table";
import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	TableBody,
	TableCell,
	TableHead,
	TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type AuditRange = "all" | "24h" | "7d" | "30d";

type AuditItem = {
	id: string;
	created_at: string;
	actor: {
		id: string | null;
		display_name: string | null;
		email: string | null;
		label: string | null;
	};
	action: string;
	resource: {
		type: string;
		id: string | null;
	};
	metadata_summary: string;
	request_id: string | null;
	details: Record<string, unknown>;
	ip_address: string | null;
	user_agent: string | null;
};

type AuditFilters = {
	range: AuditRange;
	resourceType: string;
	action: string;
	q: string;
};

const INITIAL_FILTERS: AuditFilters = {
	range: "all",
	resourceType: "all",
	action: "all",
	q: "",
};

const ALERT_THRESHOLDS_UPDATED = "workspace.alert_thresholds.updated";

const ACTION_LABELS: Record<string, readonly [zh: string, en: string]> = {
	"document.uploaded": ["上传文档", "Document uploaded"],
	"document.version_created": ["创建文档版本", "Document version created"],
	"document.reindex_requested": ["请求重新索引", "Reindex requested"],
	"document.generation_activated": [
		"激活索引版本",
		"Index generation activated",
	],
	"document.delete_requested": ["请求删除文档", "Document delete requested"],
	"document.deleted": ["删除文档", "Document deleted"],
	"document.acl_updated": ["更新文档权限", "Document access updated"],
	"library.created": ["创建知识库", "Library created"],
	"library.updated": ["更新知识库", "Library updated"],
	"library.delete_requested": ["请求删除知识库", "Library delete requested"],
	"library.deleted": ["删除知识库", "Library deleted"],
	"library.delete_failed": ["知识库删除失败", "Library deletion failed"],
	"job.cancel_requested": ["取消任务", "Job cancelled"],
	"job.retried": ["重试任务", "Job retried"],
	"workspace.created": ["创建工作区", "Workspace created"],
	[ALERT_THRESHOLDS_UPDATED]: ["更新告警阈值", "Alert thresholds updated"],
	"workspace.invite.created": ["创建成员邀请", "Invite created"],
	"workspace.invite.email": ["发送邀请邮件", "Invite email sent"],
	"workspace.invite.accepted": ["接受成员邀请", "Invite accepted"],
	"workspace.service_key_created": ["创建服务密钥", "Service key created"],
	"workspace.service_key_revoked": ["撤销服务密钥", "Service key revoked"],
	"auth.password_changed": ["修改密码", "Password changed"],
	"knowledge.ask": ["公共 API 问答", "Public API ask"],
	"knowledge.retrieve": ["公共 API 检索", "Public API retrieve"],
};

const RESOURCE_LABELS: Record<string, readonly [zh: string, en: string]> = {
	document: ["文档", "Document"],
	document_version: ["文档版本", "Document version"],
	library: ["知识库", "Library"],
	workspace: ["工作区", "Workspace"],
	workspace_invite: ["成员邀请", "Workspace invite"],
	service_key: ["服务密钥", "Service key"],
	user: ["用户账号", "User account"],
};

function isDestructiveAction(action: string): boolean {
	return (
		action.includes("delete") ||
		action.includes("revoked") ||
		action.includes("failed")
	);
}

function buildFilterSearchParams(filters: AuditFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.range !== "all") params.set("range", filters.range);
	if (filters.resourceType !== "all")
		params.set("resource_type", filters.resourceType);
	if (filters.action !== "all") params.set("action", filters.action);
	if (filters.q.trim()) params.set("q", filters.q.trim());
	return params;
}

export function WorkspaceAuditPanel() {
	const t = useInterfaceText();
	const id = useId();
	const { can } = useSession();
	const canManage = can("manageMembers");

	const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS);
	const [draftQuery, setDraftQuery] = useState("");
	const [pageSize, setPageSize] = useState<string>("25");
	const [cursors, setCursors] = useState<Array<string | null>>([null]);
	const [items, setItems] = useState<AuditItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<AuditItem | null>(null);
	const [copiedRequestId, setCopiedRequestId] = useState(false);
	const titleRef = useRef<HTMLHeadingElement | null>(null);
	const requestSeqRef = useRef(0);
	const abortRef = useRef<AbortController | null>(null);

	const rangeOptions = useMemo(
		() => [
			{ value: "all", label: t("全部时间", "All time") },
			{ value: "24h", label: t("最近 24 小时", "Last 24 hours") },
			{ value: "7d", label: t("最近 7 天", "Last 7 days") },
			{ value: "30d", label: t("最近 30 天", "Last 30 days") },
		],
		[t],
	);

	const resourceOptions = useMemo(
		() => [
			{ value: "all", label: t("全部资源", "All resources") },
			...Object.entries(RESOURCE_LABELS).map(([value, label]) => ({
				value,
				label: t(...label),
			})),
		],
		[t],
	);

	const actionOptions = useMemo(
		() => [
			{ value: "all", label: t("全部动作", "All actions") },
			{ value: "document.*", label: t("文档操作", "Document events") },
			{ value: "library.*", label: t("知识库管理", "Library events") },
			{ value: "job.*", label: t("任务控制", "Job events") },
			{ value: "workspace.*", label: t("工作区与密钥", "Workspace & keys") },
			{
				value: ALERT_THRESHOLDS_UPDATED,
				label: t(...ACTION_LABELS[ALERT_THRESHOLDS_UPDATED]),
			},
			{ value: "auth.*", label: t("账号安全", "Account security") },
			{ value: "knowledge.*", label: t("公共 API", "Public API") },
		],
		[t],
	);

	const actionLabel = useCallback(
		(action: string) => {
			const entry = ACTION_LABELS[action];
			return entry ? t(entry[0], entry[1]) : action;
		},
		[t],
	);

	const actorLabel = useCallback(
		(item: AuditItem) =>
			item.actor.label ?? t("系统 / 后台任务", "System / worker"),
		[t],
	);

	const resourceTypeLabel = useCallback(
		(type: string) => {
			const entry = RESOURCE_LABELS[type];
			return entry ? t(entry[0], entry[1]) : type;
		},
		[t],
	);

	const resourceLabel = useCallback((item: AuditItem) => {
		if (item.resource.id) return `${item.resource.type}:${item.resource.id}`;
		return item.resource.type;
	}, []);

	const activeFilterCount =
		Number(filters.range !== "all") +
		Number(filters.resourceType !== "all") +
		Number(filters.action !== "all") +
		Number(filters.q.trim().length > 0);
	const hasActiveFilters = activeFilterCount > 0;

	const currentPage = cursors.length;
	const currentCursor = cursors[cursors.length - 1] ?? null;

	const exportHref = useMemo(() => {
		const params = buildFilterSearchParams(filters);
		const query = params.toString();
		return query
			? `/api/workspace/audit/export?${query}`
			: "/api/workspace/audit/export";
	}, [filters]);

	const fetchPage = useCallback(async () => {
		if (!canManage) return;
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		const seq = ++requestSeqRef.current;

		setLoading(true);
		setError(null);
		const params = buildFilterSearchParams(filters);
		params.set("limit", pageSize);
		if (currentCursor) params.set("cursor", currentCursor);
		try {
			const response = await fetch(`/api/workspace/audit?${params}`, {
				cache: "no-store",
				signal: controller.signal,
			});
			if (seq !== requestSeqRef.current) return;
			if (!response.ok) {
				if (response.status === 403) {
					setError(
						t(
							"无权限查看审计日志（需要 owner 或 admin）",
							"Only workspace owners and admins can view audit logs.",
						),
					);
				} else if (response.status === 401) {
					setError(t("请先登录", "Please sign in first."));
				} else {
					const detail = await response.json().catch(() => null);
					setError(
						typeof detail?.detail === "string"
							? detail.detail
							: t("加载审计日志失败", "Couldn't load audit logs."),
					);
				}
				setItems([]);
				setNextCursor(null);
				setLoading(false);
				return;
			}
			const data = (await response.json()) as {
				items: AuditItem[];
				next_cursor: string | null;
			};
			if (seq !== requestSeqRef.current) return;
			setItems(data.items);
			setNextCursor(data.next_cursor);
			setLoading(false);
		} catch (err) {
			if (controller.signal.aborted || seq !== requestSeqRef.current) return;
			setError(
				err instanceof Error
					? err.message
					: t("加载审计日志失败", "Couldn't load audit logs."),
			);
			setItems([]);
			setNextCursor(null);
			setLoading(false);
		}
	}, [canManage, filters, pageSize, currentCursor, t]);

	useEffect(() => {
		void fetchPage();
		return () => abortRef.current?.abort();
	}, [fetchPage]);

	function applyFilterPatch(patch: Partial<AuditFilters>) {
		setFilters((prev) => ({ ...prev, ...patch }));
		setCursors([null]);
	}

	function resetAllFilters() {
		setDraftQuery("");
		setFilters(INITIAL_FILTERS);
		setCursors([null]);
	}

	async function copyRequestId(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			setCopiedRequestId(true);
			window.setTimeout(() => setCopiedRequestId(false), 1800);
		} catch {
			toast.error(t("复制失败，请手动选中复制", "Couldn't copy to clipboard."));
		}
	}

	if (!canManage) {
		return (
			<section className="px-4 py-8 sm:px-6">
				<h2 className="text-lg font-medium">{t("操作记录", "Audit log")}</h2>
				<p className="text-ui mt-2 text-muted-foreground">
					{t(
						"仅 owner / admin 可查看工作区审计日志与导出 CSV。",
						"Only workspace owners and admins can view audit logs or export CSV.",
					)}
				</p>
			</section>
		);
	}

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-5 pb-6 sm:px-6 md:overflow-hidden md:pb-0 lg:px-8">
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 md:min-h-0 md:flex-1 md:overflow-hidden">
				<header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
					<div className="min-w-0">
						<h2 className="text-2xl font-medium text-foreground">
							{t("操作记录", "Audit log")}
						</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							{hasActiveFilters
								? t(
										`已启用 ${activeFilterCount} 项筛选 · 导出将同步应用当前筛选`,
										`${activeFilterCount} active filter${activeFilterCount > 1 ? "s" : ""} · CSV export follows active filters`,
									)
								: t(
										"按时间倒序记录工作区关键治理、权限与接口操作",
										"Chronological record of workspace governance, access, and API events",
									)}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="icon"
							className="size-11 md:size-9"
							title={t("刷新操作记录", "Refresh audit log")}
							aria-label={t("刷新操作记录", "Refresh audit log")}
							disabled={loading}
							onClick={() => void fetchPage()}
						>
							<RefreshCw
								className={cn(
									"size-4",
									loading && "animate-spin motion-reduce:animate-none",
								)}
								aria-hidden
							/>
						</Button>
						<a
							href={exportHref}
							className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-background px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring md:h-9"
						>
							<Download className="size-4" aria-hidden />
							{hasActiveFilters
								? t("导出当前筛选 CSV", "Export filtered CSV")
								: t("导出 CSV", "Export CSV")}
						</a>
						<HelpTip label={t("操作记录权限说明", "Audit log access")}>
							{t(
								"仅 owner / admin 可查看操作记录和导出 CSV；单次导出最多包含 5,000 条匹配记录。",
								"Only owners and admins can inspect audit logs or export CSV (up to 5,000 matching rows per export).",
							)}
						</HelpTip>
					</div>
				</header>

				<form
					aria-label={t("筛选操作记录", "Filter audit log")}
					className="flex shrink-0 flex-wrap items-center gap-2 bg-background"
					onSubmit={(event) => {
						event.preventDefault();
						applyFilterPatch({ q: draftQuery });
					}}
				>
					<div className="min-w-32">
						<label className="sr-only" htmlFor={`${id}-range`}>
							{t("时间范围", "Time range")}
						</label>
						<Select
							items={rangeOptions}
							value={filters.range}
							onValueChange={(value) => {
								if (value !== null)
									applyFilterPatch({ range: value as AuditRange });
							}}
						>
							<SelectTrigger
								id={`${id}-range`}
								className="h-11 w-full bg-background md:h-9"
							>
								<SelectValue className="truncate" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{rangeOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>

					<div className="min-w-36">
						<label className="sr-only" htmlFor={`${id}-resource`}>
							{t("资源类型", "Resource type")}
						</label>
						<Select
							items={resourceOptions}
							value={filters.resourceType}
							onValueChange={(value) => {
								if (value !== null) applyFilterPatch({ resourceType: value });
							}}
						>
							<SelectTrigger
								id={`${id}-resource`}
								className="h-11 w-full bg-background md:h-9"
							>
								<SelectValue className="truncate" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{resourceOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>

					<div className="min-w-36">
						<label className="sr-only" htmlFor={`${id}-action`}>
							{t("动作类别", "Action category")}
						</label>
						<Select
							items={actionOptions}
							value={filters.action}
							onValueChange={(value) => {
								if (value !== null) applyFilterPatch({ action: value });
							}}
						>
							<SelectTrigger
								id={`${id}-action`}
								className="h-11 w-full bg-background md:h-9"
							>
								<SelectValue className="truncate" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{actionOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>

					<div className="relative min-w-[min(100%,15rem)] flex-1 sm:max-w-sm">
						<Search
							className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden
						/>
						<Input
							aria-label={t(
								"按操作者、资源 ID、Request ID 或摘要搜索",
								"Search by actor, resource ID, Request ID, or summary",
							)}
							value={draftQuery}
							onChange={(event) => setDraftQuery(event.target.value)}
							placeholder={t(
								"操作者、资源 ID、Request ID 或关键词…",
								"Actor, resource ID, Request ID, or keyword…",
							)}
							className="h-11 bg-background pl-9 md:h-9"
						/>
					</div>

					<div className="flex items-center gap-2">
						<Button
							type="submit"
							variant="outline"
							className="h-11 bg-background md:h-9"
							disabled={loading}
						>
							<Search className="size-3.5" aria-hidden />
							{t("筛选", "Filter")}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon"
							className="size-11 bg-background md:size-9"
							title={t("重置筛选", "Reset filters")}
							aria-label={t("重置筛选", "Reset filters")}
							disabled={!hasActiveFilters && draftQuery.trim().length === 0}
							onClick={resetAllFilters}
						>
							<RotateCcw className="size-4" aria-hidden />
						</Button>
					</div>
				</form>

				<div className="flex min-h-0 flex-1 flex-col md:overflow-hidden">
					{error ? (
						<div
							role="alert"
							className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
						>
							<span>{error}</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-9 shrink-0"
								onClick={() => void fetchPage()}
							>
								{t("重试", "Retry")}
							</Button>
						</div>
					) : loading && items.length === 0 ? (
						<LedgerTableSkeleton
							label={t("正在加载操作记录", "Loading audit records")}
						/>
					) : items.length === 0 ? (
						<div className="flex min-h-56 flex-1 flex-col items-center justify-center gap-2.5 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
							<p className="text-sm font-medium text-foreground">
								{hasActiveFilters
									? t(
											"没有符合当前筛选条件的操作记录",
											"No matching audit records",
										)
									: t("当前工作区暂无操作记录", "No audit records yet")}
							</p>
							<p className="max-w-md text-xs text-muted-foreground">
								{hasActiveFilters
									? t(
											"尝试放宽时间范围、切换资源或动作分类，或清空关键词。",
											"Try widening the time range, switching resource/action filters, or clearing your keyword.",
										)
									: t(
											"当成员上传/删除文档、调整权限、管理知识库或创建密钥时，记录会自动出现在这里。",
											"Document uploads, deletions, permission changes, library updates, and key operations appear here automatically.",
										)}
							</p>
							{hasActiveFilters ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-1 h-10"
									onClick={resetAllFilters}
								>
									<RotateCcw className="size-3.5" aria-hidden />
									{t("清除筛选", "Clear filters")}
								</Button>
							) : null}
						</div>
					) : (
						<>
							<ul className="divide-y divide-border/70 border-y border-border/80 md:hidden">
								{items.map((item) => (
									<li key={item.id}>
										<button
											type="button"
											onClick={() => {
												setCopiedRequestId(false);
												setSelected(item);
											}}
											className="flex w-full min-w-0 flex-col gap-1.5 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
										>
											<span className="flex w-full items-center justify-between gap-2 text-xs">
												<span
													className={cn(
														"font-medium",
														isDestructiveAction(item.action)
															? "text-destructive"
															: "text-foreground",
													)}
												>
													{actionLabel(item.action)}
												</span>
												<span className="font-mono text-muted-foreground tabular-nums">
													{formatDateTime(item.created_at)}
												</span>
											</span>
											<span className="truncate text-xs text-muted-foreground">
												{actorLabel(item)} ·{" "}
												<span className="font-mono">{resourceLabel(item)}</span>
											</span>
											{item.metadata_summary ? (
												<span className="line-clamp-2 text-xs text-muted-foreground">
													{item.metadata_summary}
												</span>
											) : null}
										</button>
									</li>
								))}
							</ul>

							<LedgerTable
								desktopOnly
								loading={loading}
								className="min-w-[52rem] table-fixed lg:table-auto"
								header={
									<TableRow className="hover:bg-transparent">
										<TableHead className="w-44">
											{t("时间", "Timestamp")}
										</TableHead>
										<TableHead className="w-40">
											{t("操作者", "Actor")}
										</TableHead>
										<TableHead className="w-44">
											{t("动作", "Action")}
										</TableHead>
										<TableHead className="w-56">
											{t("资源", "Resource")}
										</TableHead>
										<TableHead>{t("摘要", "Summary")}</TableHead>
									</TableRow>
								}
							>
								<TableBody>
									{items.map((item) => (
										<TableRow
											key={item.id}
											className="align-top hover:bg-muted/40"
										>
											<TableCell className="py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
												{formatDateTime(item.created_at)}
											</TableCell>
											<TableCell className="py-2.5 text-xs">
												<span
													className="block max-w-40 truncate text-foreground"
													title={item.actor.email ?? actorLabel(item)}
												>
													{actorLabel(item)}
												</span>
											</TableCell>
											<TableCell className="py-2.5 text-xs">
												<button
													type="button"
													onClick={() => {
														setCopiedRequestId(false);
														setSelected(item);
													}}
													className={cn(
														"inline-flex min-h-8 items-center text-left font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring",
														isDestructiveAction(item.action)
															? "text-destructive"
															: "text-evidence",
													)}
													title={item.action}
												>
													{actionLabel(item.action)}
												</button>
											</TableCell>
											<TableCell className="py-2.5 text-xs">
												<div className="min-w-0">
													<span className="text-muted-foreground">
														{resourceTypeLabel(item.resource.type)}
													</span>
													{item.resource.id ? (
														<span
															className="mt-0.5 block max-w-52 truncate font-mono text-[11px] text-muted-foreground/85"
															title={resourceLabel(item)}
														>
															{item.resource.id}
														</span>
													) : null}
												</div>
											</TableCell>
											<TableCell className="py-2.5 text-xs whitespace-normal text-muted-foreground">
												<span
													className="line-clamp-2 max-w-md [overflow-wrap:anywhere]"
													title={item.metadata_summary || undefined}
												>
													{item.metadata_summary || "—"}
												</span>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</LedgerTable>
						</>
					)}
				</div>

				<CursorPaginationBar
					page={currentPage}
					itemCount={items.length}
					pageSize={pageSize}
					hasPrev={currentPage > 1}
					hasNext={Boolean(nextCursor)}
					loading={loading}
					onPageSizeChange={(nextSize) => {
						setPageSize(nextSize);
						setCursors([null]);
					}}
					onPrev={() =>
						setCursors((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
					}
					onNext={() => {
						if (nextCursor) setCursors((prev) => [...prev, nextCursor]);
					}}
				/>
			</div>

			<Sheet
				open={selected != null}
				onOpenChange={(open) => !open && setSelected(null)}
			>
				<SheetContent
					side="right"
					initialFocus={titleRef}
					className="w-full gap-0 sm:max-w-lg [&>[data-slot=sheet-close]]:size-11"
					showCloseButton
				>
					{selected ? (
						<>
							<SheetHeader className="border-b border-border/70">
								<SheetTitle ref={titleRef} tabIndex={-1} className="pr-8">
									{actionLabel(selected.action)}
								</SheetTitle>
								<SheetDescription className="font-mono tabular-nums">
									{formatDateTime(selected.created_at)}
								</SheetDescription>
							</SheetHeader>
							<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
								<dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 text-xs">
									<dt className="text-muted-foreground">
										{t("操作者", "Actor")}
									</dt>
									<dd className="break-all">
										{actorLabel(selected)}
										{selected.actor.email &&
										selected.actor.email !== actorLabel(selected) ? (
											<span className="mt-0.5 block font-mono text-muted-foreground">
												{selected.actor.email}
											</span>
										) : null}
									</dd>
									<dt className="text-muted-foreground">
										{t("动作代码", "Action code")}
									</dt>
									<dd className="break-all font-mono">{selected.action}</dd>
									<dt className="text-muted-foreground">
										{t("资源", "Resource")}
									</dt>
									<dd className="break-all font-mono">
										{resourceLabel(selected)}
									</dd>
									<dt className="text-muted-foreground">Request ID</dt>
									<dd className="flex items-center gap-2 break-all font-mono">
										<span>{selected.request_id ?? "—"}</span>
										{selected.request_id ? (
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="size-7 shrink-0"
												aria-label={t("复制 Request ID", "Copy Request ID")}
												onClick={() =>
													void copyRequestId(selected.request_id as string)
												}
											>
												{copiedRequestId ? (
													<Check className="size-3.5 text-cite" aria-hidden />
												) : (
													<Copy className="size-3.5" aria-hidden />
												)}
											</Button>
										) : null}
									</dd>
									<dt className="text-muted-foreground">
										{t("来源 IP", "Source IP")}
									</dt>
									<dd className="break-all font-mono">
										{selected.ip_address ?? "—"}
									</dd>
									{selected.user_agent ? (
										<>
											<dt className="text-muted-foreground">User Agent</dt>
											<dd className="break-all font-mono text-muted-foreground">
												{selected.user_agent}
											</dd>
										</>
									) : null}
								</dl>
								<section>
									<p className="text-sm font-medium">
										{t("元数据", "Metadata")}
									</p>
									<pre className="mt-2 max-h-80 overflow-auto rounded-md border border-border/70 bg-muted/25 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
										{JSON.stringify(selected.details, null, 2)}
									</pre>
								</section>
							</div>
						</>
					) : null}
				</SheetContent>
			</Sheet>
		</div>
	);
}

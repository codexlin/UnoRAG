"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	ArrowRight,
	RefreshCw,
	RotateCcw,
	Search,
} from "lucide-react";
import { useId, useState } from "react";

import type { OperationsErrorRef } from "@/components/app/operations-error-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLibraries } from "@/hooks/use-libraries";
import { useQueryScope } from "@/hooks/use-query-scope";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import {
	OPERATIONS_REQUEST_QUERY_TYPES,
	OPERATIONS_REQUEST_STATUSES,
	type OperationsRequestsResult,
} from "@/lib/operations-requests";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const statuses: Record<string, string> = {
	running: "处理中",
	completed: "已完成",
	refused: "已拒答",
	failed: "失败",
	cancelled: "已取消",
};
const queryTypes: Record<string, string> = {
	fact: "事实",
	follow_up: "追问",
	summary: "总结",
	compare: "对比",
	table: "表格",
	section_lookup: "章节定位",
	ambiguous: "待澄清",
};
const initialFilters = {
	range: "24h",
	status: "",
	library_id: "",
	query_type: "",
	min_latency_ms: "",
	request_id: "",
};
const selectClass =
	"h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs";

export function OperationsRequestsPanel({
	onSelect,
}: {
	onSelect: (request: OperationsErrorRef) => void;
}) {
	const scope = useQueryScope();
	const id = useId();
	const queryClient = useQueryClient();
	const { libraries } = useLibraries();
	const [draft, setDraft] = useState(initialFilters);
	const [filters, setFilters] = useState(initialFilters);
	const [cursors, setCursors] = useState<Array<string | null>>([null]);
	const params = new URLSearchParams({ limit: "25" });
	for (const [name, value] of Object.entries(filters)) {
		if (value.trim()) params.set(name, value.trim());
	}
	const serialized = params.toString();
	const cursor = cursors.at(-1);
	const query = useQuery({
		queryKey: [...queryKeys.operationRequests(scope, serialized), cursor],
		queryFn: async ({ signal }) => {
			const search = new URLSearchParams(serialized);
			if (cursor) search.set("cursor", cursor);
			const response = await fetch(
				`/api/workspace/operations/requests?${search}`,
				{
					cache: "no-store",
					signal,
				},
			);
			if (!response.ok) throw new Error(`requests_http_${response.status}`);
			return (await response.json()) as OperationsRequestsResult;
		},
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const items = query.data?.items ?? [];
	const update = (name: keyof typeof draft, value: string) =>
		setDraft((previous) => ({ ...previous, [name]: value }));

	return (
		<section
			aria-labelledby="request-records-heading"
			className="min-w-0 space-y-4"
		>
			<div className="flex items-center justify-between gap-3">
				<h3
					id="request-records-heading"
					className="font-heading text-lg font-semibold"
				>
					请求记录
				</h3>
				<Button
					variant="outline"
					size="icon"
					title="刷新请求记录"
					disabled={query.isFetching}
					onClick={() => {
						setCursors([null]);
						void queryClient.invalidateQueries({
							queryKey: queryKeys.operationRequests(scope, serialized),
						});
					}}
				>
					<RefreshCw className={cn(query.isFetching && "animate-spin")} />
					<span className="sr-only">刷新请求记录</span>
				</Button>
			</div>
			<form
				className="grid min-w-0 grid-cols-2 items-end gap-3 lg:grid-cols-4"
				onSubmit={(event) => {
					event.preventDefault();
					setFilters({ ...draft });
					setCursors([null]);
				}}
			>
				<label
					htmlFor={`${id}-range`}
					className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
				>
					<span>时间范围</span>
					<select
						id={`${id}-range`}
						className={selectClass}
						value={draft.range}
						onChange={(event) => update("range", event.target.value)}
					>
						<option value="1h">最近 1 小时</option>
						<option value="24h">最近 24 小时</option>
						<option value="7d">最近 7 天</option>
					</select>
				</label>
				<label
					htmlFor={`${id}-status`}
					className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
				>
					<span>请求状态</span>
					<select
						id={`${id}-status`}
						className={selectClass}
						value={draft.status}
						onChange={(event) => update("status", event.target.value)}
					>
						<option value="">全部状态</option>
						{OPERATIONS_REQUEST_STATUSES.map((status) => (
							<option key={status} value={status}>
								{statuses[status]}
							</option>
						))}
					</select>
				</label>
				<label
					htmlFor={`${id}-library`}
					className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
				>
					<span>知识库</span>
					<select
						id={`${id}-library`}
						className={selectClass}
						value={draft.library_id}
						onChange={(event) => update("library_id", event.target.value)}
					>
						<option value="">全部知识库</option>
						{libraries.map((library) => (
							<option key={library.id} value={library.id}>
								{library.name}
							</option>
						))}
					</select>
				</label>
				<label
					htmlFor={`${id}-query-type`}
					className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
				>
					<span>问题类型</span>
					<select
						id={`${id}-query-type`}
						className={selectClass}
						value={draft.query_type}
						onChange={(event) => update("query_type", event.target.value)}
					>
						<option value="">全部类型</option>
						{OPERATIONS_REQUEST_QUERY_TYPES.map((type) => (
							<option key={type} value={type}>
								{queryTypes[type]}
							</option>
						))}
					</select>
				</label>
				<label
					htmlFor={`${id}-latency`}
					className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
				>
					<span>最低耗时（ms）</span>
					<Input
						id={`${id}-latency`}
						type="number"
						min="0"
						max="2147483647"
						step="1"
						value={draft.min_latency_ms}
						onChange={(event) => update("min_latency_ms", event.target.value)}
						placeholder="不限"
					/>
				</label>
				<label
					htmlFor={`${id}-request`}
					className="col-span-2 min-w-0 space-y-1.5 text-xs text-muted-foreground lg:col-span-2"
				>
					<span>Request ID</span>
					<Input
						id={`${id}-request`}
						value={draft.request_id}
						maxLength={36}
						pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
						onChange={(event) => update("request_id", event.target.value)}
						placeholder="完整 Request ID"
						className="font-mono text-xs"
					/>
				</label>
				<div className="flex gap-2">
					<Button type="submit" variant="outline" size="sm">
						<Search className="size-3.5" />
						筛选
					</Button>
					<Button
						type="button"
						variant="outline"
						size="icon"
						title="重置筛选"
						onClick={() => {
							setDraft(initialFilters);
							setFilters(initialFilters);
							setCursors([null]);
						}}
					>
						<RotateCcw />
						<span className="sr-only">重置筛选</span>
					</Button>
				</div>
			</form>
			{query.isError ? (
				<div
					role="alert"
					className="border-y border-destructive/30 py-4 text-ui text-destructive"
				>
					请求记录加载失败，请刷新或重新筛选。
				</div>
			) : (
				<>
					<ul className="divide-y divide-border/70 border-y border-border/70 md:hidden">
						{items.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									aria-label={`查看请求 ${item.request_id}`}
									onClick={() => onSelect({ source: "ask", id: item.id })}
									className="flex w-full min-w-0 flex-col gap-2 py-4 text-left hover:bg-muted/35"
								>
									<span className="flex w-full items-center justify-between gap-3 text-xs">
										<span
											className={cn(
												item.status === "failed" && "text-destructive",
												item.status === "completed" && "text-cite",
											)}
										>
											{statuses[item.status]}
										</span>
										<span className="font-mono tabular-nums">
											{item.latency_ms == null
												? "—"
												: formatDurationMs(item.latency_ms)}
										</span>
									</span>
									<span className="block w-full truncate font-mono text-xs text-cite">
										{item.request_id}
									</span>
									<span className="flex w-full flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
										<span>{formatDateTime(item.started_at)}</span>
										<span>
											{item.query_type
												? (queryTypes[item.query_type] ?? item.query_type)
												: "—"}{" "}
											· 引用 {item.citation_count}
										</span>
									</span>
								</button>
							</li>
						))}
						{items.length === 0 ? (
							<li
								className="py-10 text-center text-xs text-muted-foreground"
								role="status"
							>
								{query.isPending ? "正在读取请求记录…" : "没有符合条件的请求"}
							</li>
						) : null}
					</ul>
					<div className="hidden max-w-full overflow-x-auto border-y border-border/70 md:block">
						<table className="w-full min-w-[45rem] text-left text-xs">
							<thead className="border-b border-border/70 text-muted-foreground">
								<tr>
									{[
										"时间",
										"状态",
										"Request ID",
										"问题类型",
										"检索",
										"引用",
										"耗时",
									].map((label) => (
										<th className="px-3 py-3 font-medium" key={label}>
											{label}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="divide-y divide-border/50">
								{items.map((item) => (
									<tr key={item.id} className="hover:bg-muted/35">
										<td className="px-3 py-3 whitespace-nowrap text-muted-foreground tabular-nums">
											{formatDateTime(item.started_at)}
										</td>
										<td
											className={cn(
												"px-3 py-3 whitespace-nowrap",
												item.status === "failed" && "text-destructive",
												item.status === "completed" && "text-cite",
											)}
										>
											{statuses[item.status]}
										</td>
										<td className="px-3 py-3">
											<button
												type="button"
												onClick={() => onSelect({ source: "ask", id: item.id })}
												title={item.request_id}
												aria-label={`查看请求 ${item.request_id}`}
												className="max-w-44 truncate text-left font-mono text-cite underline-offset-4 hover:underline focus-visible:underline"
											>
												{item.request_id}
											</button>
										</td>
										<td className="px-3 py-3 whitespace-nowrap">
											{item.query_type
												? (queryTypes[item.query_type] ?? item.query_type)
												: "—"}
										</td>
										<td className="px-3 py-3 font-mono">
											{item.retrieval_mode ?? "—"}
										</td>
										<td className="px-3 py-3 tabular-nums">
											{item.citation_count}
										</td>
										<td className="px-3 py-3 whitespace-nowrap font-mono tabular-nums">
											{item.latency_ms == null
												? "—"
												: formatDurationMs(item.latency_ms)}
										</td>
									</tr>
								))}
								{items.length === 0 ? (
									<tr>
										<td
											colSpan={7}
											className="py-10 text-center text-muted-foreground"
											role="status"
										>
											{query.isPending
												? "正在读取请求记录…"
												: "没有符合条件的请求"}
										</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</div>
				</>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
				<span>
					{query.data
						? `${formatDateTime(query.data.window.from)} — ${formatDateTime(query.data.window.to)}`
						: "—"}
				</span>
				<div className="flex items-center gap-3">
					<span>
						第 {cursors.length} 页 · {items.length} 条
					</span>
					<Button
						variant="outline"
						size="icon"
						title="上一页请求"
						disabled={cursors.length < 2 || query.isFetching}
						onClick={() => setCursors((previous) => previous.slice(0, -1))}
					>
						<ArrowLeft />
						<span className="sr-only">上一页请求</span>
					</Button>
					<Button
						variant="outline"
						size="icon"
						title="下一页请求"
						disabled={
							!query.data?.next_cursor || query.isFetching || query.isError
						}
						onClick={() => {
							const next = query.data?.next_cursor;
							if (next) setCursors((previous) => [...previous, next]);
						}}
					>
						<ArrowRight />
						<span className="sr-only">下一页请求</span>
					</Button>
				</div>
			</div>
		</section>
	);
}

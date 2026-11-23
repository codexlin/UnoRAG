"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, Search } from "lucide-react";
import { useId, useState } from "react";

import {
	CursorPaginationBar,
	LedgerTable,
} from "@/components/app/ledger-table";
import type { OperationsErrorRef } from "@/components/app/operations-error-drawer";
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
	TableBody,
	TableCell,
	TableHead,
	TableRow,
} from "@/components/ui/table";
import { useLibraries } from "@/hooks/use-libraries";
import { useQueryScope } from "@/hooks/use-query-scope";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import {
	OPERATIONS_REQUEST_QUERY_TYPES,
	OPERATIONS_REQUEST_STATUSES,
	type OperationsRequestsResult,
} from "@/lib/operations-requests";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const initialFilters = {
	range: "24h",
	status: "",
	library_id: "",
	query_type: "",
	min_latency_ms: "",
	request_id: "",
};

export function OperationsRequestsPanel({
	onSelect,
}: {
	onSelect: (request: OperationsErrorRef) => void;
}) {
	const t = useInterfaceText();
	const scope = useQueryScope();
	const id = useId();
	const queryClient = useQueryClient();
	const { libraries } = useLibraries();
	const statuses: Record<string, string> = {
		running: t("处理中", "Running"),
		completed: t("已完成", "Completed"),
		refused: t("已拒答", "Refused"),
		failed: t("失败", "Failed"),
		cancelled: t("已取消", "Cancelled"),
	};
	const queryTypes: Record<string, string> = {
		fact: t("事实", "Fact"),
		follow_up: t("追问", "Follow-up"),
		summary: t("总结", "Summary"),
		compare: t("对比", "Compare"),
		table: t("表格", "Table"),
		section_lookup: t("章节定位", "Section lookup"),
		ambiguous: t("待澄清", "Ambiguous"),
	};
	const rangeOptions = [
		{ value: "1h", label: t("最近 1 小时", "Last 1 hour") },
		{ value: "24h", label: t("最近 24 小时", "Last 24 hours") },
		{ value: "7d", label: t("最近 7 天", "Last 7 days") },
	];
	const statusOptions = [
		{ value: "", label: t("全部状态", "All statuses") },
		...OPERATIONS_REQUEST_STATUSES.map((value) => ({
			value,
			label: statuses[value],
		})),
	];
	const queryTypeOptions = [
		{ value: "", label: t("全部类型", "All types") },
		...OPERATIONS_REQUEST_QUERY_TYPES.map((value) => ({
			value,
			label: queryTypes[value],
		})),
	];
	const libraryOptions = [
		{ value: "", label: t("全部知识库", "All libraries") },
		...libraries.map((library) => ({ value: library.id, label: library.name })),
	];
	const [draft, setDraft] = useState(initialFilters);
	const [filters, setFilters] = useState(initialFilters);
	const [pageSize, setPageSize] = useState("25");
	const [cursors, setCursors] = useState<Array<string | null>>([null]);
	const params = new URLSearchParams({ limit: pageSize });
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
	const applyImmediate = (name: keyof typeof draft, value: string) => {
		setDraft((previous) => ({ ...previous, [name]: value }));
		setFilters((previous) => ({ ...previous, [name]: value }));
		setCursors([null]);
	};

	return (
		<section
			aria-labelledby="request-records-heading"
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:overflow-hidden"
		>
			<h3 id="request-records-heading" className="sr-only">
				{t("请求记录", "Request records")}
			</h3>
			<form
				className="flex shrink-0 flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					setFilters({ ...draft });
					setCursors([null]);
				}}
			>
				<label
					htmlFor={`${id}-range`}
					className="w-32 min-w-0 space-y-1 text-xs text-muted-foreground"
				>
					<span>{t("时间范围", "Time range")}</span>
					<Select
						items={rangeOptions}
						value={draft.range}
						onValueChange={(value) => {
							if (value !== null) applyImmediate("range", value);
						}}
					>
						<SelectTrigger
							id={`${id}-range`}
							aria-label={t("时间范围", "Time range")}
							className="h-11 w-full min-w-0 bg-background md:h-9"
						>
							<SelectValue className="min-w-0 truncate" />
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
				</label>
				<label
					htmlFor={`${id}-status`}
					className="w-32 min-w-0 space-y-1 text-xs text-muted-foreground"
				>
					<span>{t("请求状态", "Request status")}</span>
					<Select
						items={statusOptions}
						value={draft.status}
						onValueChange={(value) => {
							if (value !== null) applyImmediate("status", value);
						}}
					>
						<SelectTrigger
							id={`${id}-status`}
							aria-label={t("请求状态", "Request status")}
							className="h-11 w-full min-w-0 bg-background md:h-9"
						>
							<SelectValue className="min-w-0 truncate" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{statusOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</label>
				<label
					htmlFor={`${id}-library`}
					className="w-40 min-w-0 space-y-1 text-xs text-muted-foreground"
				>
					<span>{t("知识库", "Library")}</span>
					<Select
						items={libraryOptions}
						value={draft.library_id}
						onValueChange={(value) => {
							if (value !== null) applyImmediate("library_id", value);
						}}
					>
						<SelectTrigger
							id={`${id}-library`}
							aria-label={t("知识库", "Library")}
							className="h-11 w-full min-w-0 bg-background md:h-9"
						>
							<SelectValue className="min-w-0 truncate" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{libraryOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</label>
				<label
					htmlFor={`${id}-query-type`}
					className="w-32 min-w-0 space-y-1 text-xs text-muted-foreground"
				>
					<span>{t("问题类型", "Query type")}</span>
					<Select
						items={queryTypeOptions}
						value={draft.query_type}
						onValueChange={(value) => {
							if (value !== null) applyImmediate("query_type", value);
						}}
					>
						<SelectTrigger
							id={`${id}-query-type`}
							aria-label={t("问题类型", "Query type")}
							className="h-11 w-full min-w-0 bg-background md:h-9"
						>
							<SelectValue className="min-w-0 truncate" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{queryTypeOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</label>
				<label
					htmlFor={`${id}-latency`}
					className="w-28 min-w-0 space-y-1 text-xs text-muted-foreground"
				>
					<span>{t("最低耗时(ms)", "Min ms")}</span>
					<Input
						id={`${id}-latency`}
						className="h-11 bg-background md:h-9"
						type="number"
						min="0"
						max="2147483647"
						step="1"
						value={draft.min_latency_ms}
						onChange={(event) => update("min_latency_ms", event.target.value)}
						placeholder={t("不限", "Any")}
					/>
				</label>
				<label
					htmlFor={`${id}-request`}
					className="min-w-[12rem] flex-1 space-y-1 text-xs text-muted-foreground"
				>
					<span>Request ID</span>
					<Input
						id={`${id}-request`}
						value={draft.request_id}
						maxLength={36}
						pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
						onChange={(event) => update("request_id", event.target.value)}
						placeholder={t("完整 Request ID", "Full Request ID")}
						className="h-11 bg-background font-mono text-xs md:h-9"
					/>
				</label>
				<div className="flex items-center gap-1.5">
					<Button type="submit" variant="outline" className="h-11 md:h-9">
						<Search className="size-3.5" aria-hidden />
						{t("筛选", "Filter")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="size-11 md:size-9"
						title={t("重置筛选", "Reset filters")}
						onClick={() => {
							setDraft(initialFilters);
							setFilters(initialFilters);
							setCursors([null]);
						}}
					>
						<RotateCcw className="size-3.5" aria-hidden />
						<span className="sr-only">{t("重置筛选", "Reset filters")}</span>
					</Button>
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="size-11 md:size-9"
						title={t("刷新请求记录", "Refresh request records")}
						disabled={query.isFetching}
						onClick={() => {
							setCursors([null]);
							void queryClient.invalidateQueries({
								queryKey: queryKeys.operationRequests(scope, serialized),
							});
						}}
					>
						<RefreshCw
							className={cn(
								"size-3.5",
								query.isFetching && "animate-spin motion-reduce:animate-none",
							)}
							aria-hidden
						/>
						<span className="sr-only">
							{t("刷新请求记录", "Refresh request records")}
						</span>
					</Button>
				</div>
			</form>
			{query.isError ? (
				<div
					role="alert"
					className="border-y border-destructive/30 py-4 text-ui text-destructive"
				>
					{t(
						"请求记录加载失败，请刷新或重新筛选。",
						"Failed to load request records. Refresh or adjust filters.",
					)}
				</div>
			) : (
				<>
					<ul className="divide-y divide-border/70 border-y border-border/70 md:hidden">
						{items.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									aria-label={t(
										`查看请求 ${item.request_id}`,
										`View request ${item.request_id}`,
									)}
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
									<span className="block w-full truncate font-mono text-xs text-evidence">
										{item.request_id}
									</span>
									<span className="flex w-full flex-wrap justify-between gap-2 text-xs text-muted-foreground">
										<span>{formatDateTime(item.started_at)}</span>
										<span>
											{item.query_type
												? (queryTypes[item.query_type] ?? item.query_type)
												: "—"}{" "}
											·{" "}
											{t(
												`引用 ${item.citation_count}`,
												`${item.citation_count} ${item.citation_count === 1 ? "citation" : "citations"}`,
											)}
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
								{query.isPending
									? t("正在读取请求记录…", "Loading request records…")
									: t("没有符合条件的请求", "No matching requests")}
							</li>
						) : null}
					</ul>
					<LedgerTable
						desktopOnly
						loading={query.isFetching && items.length > 0}
						className="min-w-[45rem] text-xs"
						header={
							<TableRow className="hover:bg-transparent">
								{[
									t("时间", "Time"),
									t("状态", "Status"),
									"Request ID",
									t("问题类型", "Query type"),
									t("检索", "Retrieval"),
									t("引用", "Citations"),
									t("耗时", "Latency"),
								].map((label) => (
									<TableHead className="px-3 text-xs" key={label}>
										{label}
									</TableHead>
								))}
							</TableRow>
						}
					>
						<TableBody>
							{items.map((item) => (
								<TableRow key={item.id} className="hover:bg-muted/40">
									<TableCell className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
										{formatDateTime(item.started_at)}
									</TableCell>
									<TableCell
										className={cn(
											"px-3 py-2.5 text-xs whitespace-nowrap",
											item.status === "failed" && "text-destructive",
											item.status === "completed" && "text-cite",
										)}
									>
										{statuses[item.status]}
									</TableCell>
									<TableCell className="px-3 py-2.5 text-xs">
										<button
											type="button"
											onClick={() => onSelect({ source: "ask", id: item.id })}
											title={item.request_id}
											aria-label={t(
												`查看请求 ${item.request_id}`,
												`View request ${item.request_id}`,
											)}
											className="inline-flex min-h-8 max-w-44 items-center truncate text-left font-mono text-evidence underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
										>
											{item.request_id}
										</button>
									</TableCell>
									<TableCell className="px-3 py-2.5 text-xs whitespace-nowrap">
										{item.query_type
											? (queryTypes[item.query_type] ?? item.query_type)
											: "—"}
									</TableCell>
									<TableCell className="px-3 py-2.5 font-mono text-xs">
										{item.retrieval_mode ?? "—"}
									</TableCell>
									<TableCell className="px-3 py-2.5 text-xs tabular-nums">
										{item.citation_count}
									</TableCell>
									<TableCell className="px-3 py-2.5 font-mono text-xs whitespace-nowrap tabular-nums">
										{item.latency_ms == null
											? "—"
											: formatDurationMs(item.latency_ms)}
									</TableCell>
								</TableRow>
							))}
							{items.length === 0 ? (
								<TableRow className="hover:bg-transparent">
									<TableCell
										colSpan={7}
										className="py-10 text-center text-xs text-muted-foreground"
										role="status"
									>
										{query.isPending
											? t("正在读取请求记录…", "Loading request records…")
											: t("没有符合条件的请求", "No matching requests")}
									</TableCell>
								</TableRow>
							) : null}
						</TableBody>
					</LedgerTable>
				</>
			)}
			<CursorPaginationBar
				page={cursors.length}
				itemCount={items.length}
				pageSize={pageSize}
				hasPrev={cursors.length >= 2}
				hasNext={Boolean(query.data?.next_cursor) && !query.isError}
				loading={query.isFetching}
				meta={
					query.data ? (
						<span className="hidden font-mono tabular-nums xl:inline">
							{formatDateTime(query.data.window.from)} —{" "}
							{formatDateTime(query.data.window.to)}
						</span>
					) : null
				}
				onPageSizeChange={(nextSize) => {
					setPageSize(nextSize);
					setCursors([null]);
				}}
				onPrev={() => setCursors((previous) => previous.slice(0, -1))}
				onNext={() => {
					const next = query.data?.next_cursor;
					if (next) setCursors((previous) => [...previous, next]);
				}}
			/>
		</section>
	);
}

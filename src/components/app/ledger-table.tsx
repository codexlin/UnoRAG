"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Table, TableHeader } from "@/components/ui/table";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const DEFAULT_PAGE_SIZES = ["25", "50", "100"] as const;
const SKELETON_ROW_IDS = [
	"row-1",
	"row-2",
	"row-3",
	"row-4",
	"row-5",
	"row-6",
	"row-7",
	"row-8",
	"row-9",
	"row-10",
] as const;

export function LedgerTable({
	header,
	children,
	className,
	containerClassName,
	loading = false,
	desktopOnly = false,
}: {
	header: ReactNode;
	children: ReactNode;
	className?: string;
	containerClassName?: string;
	loading?: boolean;
	desktopOnly?: boolean;
}) {
	return (
		<Table
			containerProps={{
				className: cn(
					"max-w-full rounded-md border border-border/80 bg-card shadow-2xs md:min-h-0 md:flex-1 md:overflow-auto md:[scrollbar-gutter:stable]",
					desktopOnly && "hidden md:block",
					loading && "opacity-65 transition-opacity",
					containerClassName,
				),
				tabIndex: 0,
			}}
			className={className}
		>
			<TableHeader className="bg-card md:sticky md:top-0 md:z-10 [&_th]:h-10 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
				{header}
			</TableHeader>
			{children}
		</Table>
	);
}

export function LedgerTableSkeleton({
	rows = 8,
	label,
	className,
}: {
	rows?: number;
	label?: string;
	className?: string;
}) {
	const t = useInterfaceText();
	const rowIds = SKELETON_ROW_IDS.slice(
		0,
		Math.max(1, Math.min(rows, SKELETON_ROW_IDS.length)),
	);
	return (
		<div
			role="status"
			aria-label={label ?? t("正在加载列表", "Loading records")}
			className={cn(
				"min-h-0 flex-1 overflow-hidden border-y border-border/80",
				className,
			)}
		>
			<div className="divide-y divide-border/50">
				{rowIds.map((rowId) => (
					<div
						key={rowId}
						className="grid grid-cols-[9rem_8rem_9rem_1fr] items-center gap-4 px-3 py-3.5"
					>
						<div className="h-3.5 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
						<div className="h-3.5 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
						<div className="h-3.5 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
						<div className="h-3.5 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
					</div>
				))}
			</div>
		</div>
	);
}

export function CursorPaginationBar({
	page,
	itemCount,
	pageSize,
	pageSizes = DEFAULT_PAGE_SIZES,
	hasPrev,
	hasNext,
	loading = false,
	meta,
	className,
	onPageSizeChange,
	onPrev,
	onNext,
}: {
	page: number;
	itemCount: number;
	pageSize: string;
	pageSizes?: readonly string[];
	hasPrev: boolean;
	hasNext: boolean;
	loading?: boolean;
	meta?: ReactNode;
	className?: string;
	onPageSizeChange: (nextSize: string) => void;
	onPrev: () => void;
	onNext: () => void;
}) {
	const t = useInterfaceText();
	const id = useId();
	const options = useMemo(
		() =>
			pageSizes.map((value) => ({
				value,
				label: t(`每页 ${value} 条`, `${value} / page`),
			})),
		[pageSizes, t],
	);

	return (
		<footer
			className={cn(
				"flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-background py-3 text-xs text-muted-foreground",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-3">
				<div className="w-32">
					<label className="sr-only" htmlFor={`${id}-page-size`}>
						{t("每页条数", "Rows per page")}
					</label>
					<Select
						items={options}
						value={pageSize}
						onValueChange={(value) => {
							if (value !== null) onPageSizeChange(value);
						}}
					>
						<SelectTrigger
							id={`${id}-page-size`}
							className="h-11 w-full bg-background md:h-9"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{options.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
				<span className="tabular-nums">
					{t(
						`第 ${page} 页 · 本页 ${itemCount} 条`,
						`Page ${page} · ${itemCount} shown`,
					)}
				</span>
				{meta}
			</div>

			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					className="h-11 md:h-9"
					disabled={!hasPrev || loading}
					onClick={onPrev}
				>
					<ArrowLeft className="size-3.5" aria-hidden />
					{t("上一页", "Previous")}
				</Button>
				<Button
					type="button"
					variant="outline"
					className="h-11 md:h-9"
					disabled={!hasNext || loading}
					onClick={onNext}
				>
					{t("下一页", "Next")}
					<ArrowRight className="size-3.5" aria-hidden />
				</Button>
			</div>
		</footer>
	);
}

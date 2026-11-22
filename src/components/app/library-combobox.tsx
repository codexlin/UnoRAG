"use client";

import { useMemo } from "react";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import type { ApiLibrary } from "@/lib/api";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export type LibraryOption = {
	value: string;
	label: string;
	status: string;
};

function toOption(
	library: ApiLibrary,
	t: ReturnType<typeof useInterfaceText>,
): LibraryOption {
	const suffix =
		library.status === "deleting"
			? t(" · 删除中", " · Deleting")
			: library.status === "indexing"
				? t(" · 索引中", " · Indexing")
				: library.status === "degraded"
					? t(" · 部分可检索", " · Partly searchable")
					: library.status === "failed"
						? t(" · 不可用", " · Unavailable")
						: library.status === "empty"
							? t(" · 空", " · Empty")
							: "";
	return {
		value: library.id,
		label: `${library.name}${suffix}`,
		status: library.status,
	};
}

type LibraryComboboxProps = {
	libraries: ApiLibrary[];
	value: string;
	onValueChange: (libraryId: string) => void;
	disabled?: boolean;
	className?: string;
	label?: string;
	/** Hide the external label (toolbar / compact layouts). */
	showLabel?: boolean;
};

export function LibraryCombobox({
	libraries,
	value,
	onValueChange,
	disabled,
	className,
	label: customLabel,
	showLabel = true,
}: LibraryComboboxProps) {
	const t = useInterfaceText();
	const label = customLabel ?? t("知识库", "Library");
	const items = useMemo(
		() => libraries.map((library) => toOption(library, t)),
		[libraries, t],
	);
	const selected = useMemo(
		() => items.find((item) => item.value === value) ?? null,
		[items, value],
	);

	return (
		<div className={cn("flex min-w-0 flex-col gap-1", className)}>
			{showLabel ? (
				<Label
					htmlFor="library-combobox"
					className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase"
				>
					{label}
				</Label>
			) : (
				<span className="sr-only">{label}</span>
			)}
			<Combobox
				items={items}
				value={selected}
				onValueChange={(next) => {
					if (next) onValueChange(next.value);
				}}
				isItemEqualToValue={(a, b) => a.value === b.value}
				disabled={disabled || items.length === 0}
			>
				<ComboboxInput
					id="library-combobox"
					aria-label={label}
					placeholder={
						items.length
							? t("搜索或选择知识库…", "Search or select a library…")
							: t("暂无知识库", "No libraries")
					}
					className="w-full"
					showClear={false}
				/>
				<ComboboxContent className="min-w-(--anchor-width)">
					<ComboboxEmpty>
						{t("无匹配知识库", "No matching libraries")}
					</ComboboxEmpty>
					<ComboboxList>
						{(item) => (
							<ComboboxItem key={item.value} value={item}>
								<span className="truncate">{item.label}</span>
							</ComboboxItem>
						)}
					</ComboboxList>
				</ComboboxContent>
			</Combobox>
		</div>
	);
}

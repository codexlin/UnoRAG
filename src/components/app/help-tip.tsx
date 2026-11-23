"use client";

import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";

import { useInterfaceLanguage } from "@/lib/i18n/provider";

export function HelpTip({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	const { locale } = useInterfaceLanguage();
	const ariaLabel =
		locale === "zh-CN"
			? label.endsWith("说明")
				? label
				: `${label}说明`
			: label;
	return (
		<Popover>
			<PopoverTrigger
				openOnHover
				delay={250}
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-11 shrink-0 text-muted-foreground"
						aria-label={ariaLabel}
					/>
				}
			>
				<CircleHelp className="size-4" aria-hidden />
			</PopoverTrigger>
			<PopoverContent align="start" className="gap-1.5 leading-relaxed">
				<PopoverTitle>{label}</PopoverTitle>
				<PopoverDescription render={<div />}>{children}</PopoverDescription>
			</PopoverContent>
		</Popover>
	);
}

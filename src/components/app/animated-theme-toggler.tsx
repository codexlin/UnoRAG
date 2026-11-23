"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { type MouseEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import {
	runCircularThemeTransition,
	syncResolvedColorMode,
} from "@/lib/view-transition";

type AnimatedThemeTogglerProps = {
	className?: string;
};

export function AnimatedThemeToggler({ className }: AnimatedThemeTogglerProps) {
	const t = useInterfaceText();
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const isDark = mounted && resolvedTheme === "dark";
	const nextMode = isDark ? "light" : "dark";
	const label = isDark
		? t("切换到浅色模式", "Switch to light mode")
		: t("切换到深色模式", "Switch to dark mode");

	function handleToggle(event: MouseEvent<HTMLButtonElement>) {
		const origin =
			event.clientX > 0 || event.clientY > 0
				? { x: event.clientX, y: event.clientY }
				: event.currentTarget;
		runCircularThemeTransition(() => {
			syncResolvedColorMode(nextMode);
			setTheme(nextMode);
		}, origin);
	}

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			onClick={handleToggle}
			disabled={!mounted}
			aria-label={label}
			title={label}
			className={cn("size-11 md:size-9", className)}
		>
			{isDark ? (
				<Sun className="size-4" aria-hidden />
			) : (
				<Moon className="size-4" aria-hidden />
			)}
		</Button>
	);
}

"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const isDark = mounted && resolvedTheme === "dark";

	return (
		<Button
			type="button"
			variant="outline"
			size="icon-sm"
			aria-label={isDark ? "切换到浅色模式" : "切换到深色模式"}
			title={isDark ? "浅色模式" : "深色模式"}
			disabled={!mounted}
			onClick={() => setTheme(isDark ? "light" : "dark")}
			className="rounded-md border-border/80 bg-background/80 text-muted-foreground transition-colors hover:border-cite/40 hover:text-foreground"
		>
			{isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
		</Button>
	);
}

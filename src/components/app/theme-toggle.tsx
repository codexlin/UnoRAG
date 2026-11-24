"use client";

import { Check, Monitor, Moon, Palette, RotateCcw, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { useAppearance } from "@/hooks/use-appearance";
import {
	type Appearance,
	COLOR_THEMES,
	DEFAULT_APPEARANCE,
	normalizeRadius,
	presetRadiusForTheme,
	RADIUS_QUICK_STOPS,
	RADIUS_RANGE,
	type RadiusPreference,
	resolveRadius,
} from "@/lib/appearance";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import {
	runCircularThemeTransition,
	syncResolvedColorMode,
} from "@/lib/view-transition";

const MODES = [
	{ id: "light", label: ["浅色", "Light"], icon: Sun },
	{ id: "dark", label: ["深色", "Dark"], icon: Moon },
	{ id: "system", label: ["跟随系统", "System"], icon: Monitor },
] as const;

const optionClassName =
	"relative flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-2 py-3 text-sm transition-colors duration-150 hover:bg-muted has-[[data-checked]]:border-ring has-[[data-checked]]:bg-muted has-[[data-checked]]:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring motion-reduce:transition-none";

function RadiusControl({
	appearance,
	onChange,
}: {
	appearance: Appearance;
	onChange: (value: RadiusPreference) => void;
}) {
	const t = useInterfaceText();
	const id = useId();
	const resolved = resolveRadius(appearance);
	const isPreset = appearance.radius === "preset";
	const themePresetPx = presetRadiusForTheme(appearance.color);
	const [draft, setDraft] = useState(String(resolved));
	useEffect(() => setDraft(String(resolved)), [resolved]);
	return (
		<fieldset className="space-y-3">
			<div className="flex items-baseline justify-between gap-2">
				<legend className="text-sm font-medium">
					{t("圆角", "Corner radius")}
				</legend>
				<span className="font-mono text-xs tabular-nums text-muted-foreground">
					{isPreset
						? t(`跟随预设 · ${themePresetPx}px`, `Preset · ${themePresetPx}px`)
						: `${resolved}px`}
				</span>
			</div>
			<fieldset
				aria-label={t("圆角快捷档位", "Quick corner radius presets")}
				className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/50 p-1"
			>
				<button
					type="button"
					aria-pressed={isPreset}
					onClick={() => onChange("preset")}
					className={cn(
						"min-h-8 rounded-md px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
						isPreset
							? "bg-background text-foreground shadow-xs"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{t("跟随预设", "Preset")}
				</button>
				{RADIUS_QUICK_STOPS.map((stop) => {
					const active = !isPreset && appearance.radius === stop;
					return (
						<button
							key={stop}
							type="button"
							aria-pressed={active}
							onClick={() => onChange(stop)}
							className={cn(
								"min-h-8 rounded-md px-2 font-mono text-xs tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
								active
									? "bg-background font-medium text-foreground shadow-xs"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{stop}px
						</button>
					);
				})}
			</fieldset>
			<div className="flex min-w-0 flex-wrap items-center gap-3">
				<div className="min-w-[min(100%,10rem)] flex-1">
					<Slider
						min={RADIUS_RANGE.min}
						max={RADIUS_RANGE.max}
						step={RADIUS_RANGE.step}
						value={[resolved]}
						getAriaLabel={() => t("圆角大小", "Corner radius")}
						getAriaValueText={(_, pixels) =>
							t(`${pixels} 像素`, `${pixels} pixels`)
						}
						onValueChange={(pixels) =>
							onChange(Array.isArray(pixels) ? pixels[0] : pixels)
						}
					/>
					<div
						aria-hidden
						className="flex justify-between text-xs tabular-nums text-muted-foreground"
					>
						<span>{RADIUS_RANGE.min}</span>
						<span>{RADIUS_RANGE.max}</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5 self-start">
					<label htmlFor={`${id}-number`} className="sr-only">
						{t("圆角数值", "Corner radius value")}
					</label>
					<Input
						id={`${id}-number`}
						type="number"
						min={RADIUS_RANGE.min}
						max={RADIUS_RANGE.max}
						step={RADIUS_RANGE.step}
						value={draft}
						className="h-11 w-18 tabular-nums md:h-9"
						onChange={(event) => setDraft(event.currentTarget.value)}
						onBlur={(event) => {
							const number = event.currentTarget.valueAsNumber;
							const next = Number.isFinite(number)
								? normalizeRadius(number)
								: resolved;
							if (next !== resolved || !isPreset) onChange(next);
							setDraft(String(next));
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}}
					/>
					<span aria-hidden className="text-xs text-muted-foreground">
						px
					</span>
				</div>
			</div>
		</fieldset>
	);
}

function ThemePreview({
	theme,
	radius,
}: {
	theme: Appearance["color"];
	radius: number;
}) {
	return (
		<span
			data-theme-preview={theme}
			aria-hidden
			style={{ "--radius": `${radius}px` } as React.CSSProperties}
			className="pointer-events-none flex aspect-[16/9] w-full shrink-0 overflow-hidden rounded-md border border-border bg-background font-sans text-foreground"
		>
			<span className="flex w-[24%] shrink-0 flex-col gap-[5px] border-r border-border bg-sidebar p-[6%]">
				<span className="mb-[3px] aspect-square w-3/4 rounded-sm bg-sidebar-primary" />
				{[0, 1, 2].map((line) => (
					<span key={line} className="h-[4px] w-full rounded-sm bg-secondary" />
				))}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-[4px] p-[7%]">
				<span className="text-[11px] leading-[11px] font-semibold">Aa</span>
				<span className="mt-[2px] h-[4px] w-full rounded-sm bg-secondary" />
				<span className="h-[4px] w-2/3 rounded-sm bg-secondary" />
				<span className="mt-auto h-[8px] w-2/5 self-end rounded-sm bg-primary" />
			</span>
		</span>
	);
}

export function ThemeToggle() {
	const t = useInterfaceText();
	const id = useId();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const { theme, setTheme } = useTheme();
	const { appearance, setAppearance } = useAppearance();

	function handleColorChange(color: Appearance["color"]) {
		const trigger = document.getElementById(`${id}-color-${color}`);
		runCircularThemeTransition(() => {
			setAppearance({ color });
		}, trigger);
	}

	function handleModeChange(nextMode: string) {
		const trigger = document.getElementById(`${id}-mode-${nextMode}`);
		const resolved: "light" | "dark" =
			nextMode === "dark"
				? "dark"
				: nextMode === "light"
					? "light"
					: window.matchMedia("(prefers-color-scheme: dark)").matches
						? "dark"
						: "light";
		runCircularThemeTransition(() => {
			syncResolvedColorMode(resolved);
			setTheme(nextMode);
		}, trigger);
	}

	return (
		<Sheet>
			<SheetTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className="size-11 md:size-9"
						aria-label={t("外观设置", "Appearance settings")}
						title={t("外观设置", "Appearance settings")}
						disabled={!mounted}
					/>
				}
			>
				<Palette aria-hidden />
			</SheetTrigger>
			<SheetContent
				className="w-full max-w-sm! gap-0 overflow-y-auto [&>[data-slot=sheet-close]]:size-11"
				aria-describedby={undefined}
			>
				<SheetHeader className="border-b p-5">
					<SheetTitle>{t("外观", "Appearance")}</SheetTitle>
				</SheetHeader>
				<div className="space-y-7 p-5">
					<fieldset>
						<legend className="mb-3 text-sm font-medium">
							{t("主题", "Theme")}
						</legend>
						<RadioGroup
							aria-label={t("主题", "Theme")}
							name="appearance-color"
							value={appearance.color}
							onValueChange={handleColorChange}
							className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2.5"
						>
							{COLOR_THEMES.map((item) => (
								<Label
									key={item.id}
									htmlFor={`${id}-color-${item.id}`}
									className="relative flex min-w-0 cursor-pointer flex-col items-stretch gap-2 rounded-lg border border-border p-2.5 text-sm leading-snug transition-colors duration-150 hover:bg-muted/50 has-[[data-checked]]:border-ring has-[[data-checked]]:bg-muted/50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring motion-reduce:transition-none"
								>
									<RadioGroupItem
										id={`${id}-color-${item.id}`}
										className="absolute inset-0 size-full cursor-pointer rounded-lg opacity-0 after:hidden"
										aria-label={item.label}
										value={item.id}
									/>
									<ThemePreview theme={item.id} radius={item.radius} />
									<span className="flex min-w-0 items-center justify-between gap-1.5">
										<span className="min-w-0 flex-1 text-xs font-medium [overflow-wrap:anywhere]">
											{item.label}
										</span>
										<span className="flex shrink-0 items-center gap-1">
											<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
												{item.radius}px
											</span>
											{appearance.color === item.id ? (
												<Check className="size-3.5 text-primary" aria-hidden />
											) : null}
										</span>
									</span>
								</Label>
							))}
						</RadioGroup>
					</fieldset>
					<fieldset>
						<legend className="mb-3 text-sm font-medium">
							{t("明暗", "Color mode")}
						</legend>
						<RadioGroup
							aria-label={t("明暗", "Color mode")}
							name="appearance-mode"
							value={theme ?? "dark"}
							onValueChange={handleModeChange}
							className="grid-cols-[repeat(auto-fit,minmax(min(100%,5rem),1fr))]"
						>
							{MODES.map((item) => (
								<Label
									key={item.id}
									htmlFor={`${id}-mode-${item.id}`}
									className={`${optionClassName} flex-col text-xs`}
								>
									<RadioGroupItem
										id={`${id}-mode-${item.id}`}
										className="absolute inset-0 size-full cursor-pointer rounded-lg opacity-0 after:hidden"
										aria-label={t(item.label[0], item.label[1])}
										value={item.id}
									/>
									<item.icon className="size-4" aria-hidden />
									{t(item.label[0], item.label[1])}
								</Label>
							))}
						</RadioGroup>
					</fieldset>
					<RadiusControl
						appearance={appearance}
						onChange={(radius) => setAppearance({ radius })}
					/>
					<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
						<span className="text-xs text-muted-foreground">
							{t("当前浏览器", "This browser")}
						</span>
						<Button
							variant="ghost"
							className="min-h-11"
							onClick={(event) => {
								runCircularThemeTransition(() => {
									setAppearance(DEFAULT_APPEARANCE);
									syncResolvedColorMode("dark");
									setTheme("dark");
								}, event.currentTarget);
							}}
						>
							<RotateCcw aria-hidden />
							{t("恢复默认", "Restore defaults")}
						</Button>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

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
	RADIUS_RANGE,
} from "@/lib/appearance";

const MODES = [
	{ id: "light", label: "浅色", icon: Sun },
	{ id: "dark", label: "深色", icon: Moon },
	{ id: "system", label: "跟随系统", icon: Monitor },
] as const;

const optionClassName =
	"relative flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-2 py-3 text-sm transition-colors duration-150 hover:bg-muted has-[[data-checked]]:border-ring has-[[data-checked]]:bg-muted has-[[data-checked]]:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring motion-reduce:transition-none";

function RadiusControl({
	value,
	onChange,
}: {
	value: number;
	onChange: (value: number) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return (
		<fieldset>
			<legend className="mb-3 text-sm font-medium">圆角</legend>
			<div className="flex min-w-0 flex-wrap items-center gap-3">
				<div className="min-w-[min(100%,10rem)] flex-1">
					<Slider
						min={RADIUS_RANGE.min}
						max={RADIUS_RANGE.max}
						step={RADIUS_RANGE.step}
						value={[value]}
						getAriaLabel={() => "圆角大小"}
						getAriaValueText={(_, pixels) => `${pixels} 像素`}
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
						圆角数值
					</label>
					<Input
						id={`${id}-number`}
						type="number"
						min={RADIUS_RANGE.min}
						max={RADIUS_RANGE.max}
						step={RADIUS_RANGE.step}
						value={draft}
						className="h-11 w-18 tabular-nums"
						onChange={(event) => setDraft(event.currentTarget.value)}
						onBlur={(event) => {
							const number = event.currentTarget.valueAsNumber;
							const next = Number.isFinite(number)
								? normalizeRadius(number)
								: value;
							onChange(next);
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

function ThemePreview({ theme }: { theme: Appearance["color"] }) {
	return (
		<span
			data-theme-preview={theme}
			aria-hidden
			className="pointer-events-none flex aspect-[7/4] w-28 max-w-[28%] shrink-0 overflow-hidden rounded-md border border-border bg-background font-sans text-foreground"
		>
			<span className="flex w-[22%] shrink-0 flex-col gap-[6px] border-r border-border bg-sidebar p-[5%]">
				<span className="mb-[4px] aspect-square w-full rounded-sm bg-foreground" />
				{[0, 1, 2].map((line) => (
					<span key={line} className="h-[4px] w-full rounded-sm bg-secondary" />
				))}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-[4px] p-[7%]">
				<span className="text-[12px] leading-[12px] font-semibold">Aa</span>
				<span className="mt-[2px] h-[4px] w-full rounded-sm bg-secondary" />
				<span className="h-[4px] w-2/3 rounded-sm bg-secondary" />
				<span className="mt-auto h-[8px] w-1/3 self-end rounded-sm bg-primary" />
			</span>
		</span>
	);
}

export function ThemeToggle() {
	const id = useId();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const { theme, setTheme } = useTheme();
	const { appearance, setAppearance } = useAppearance();
	return (
		<Sheet>
			<SheetTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className="size-11"
						aria-label="外观设置"
						title="外观设置"
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
					<SheetTitle>外观</SheetTitle>
				</SheetHeader>
				<div className="space-y-7 p-5">
					<fieldset>
						<legend className="mb-3 text-sm font-medium">主题</legend>
						<RadioGroup
							aria-label="主题"
							name="appearance-color"
							value={appearance.color}
							onValueChange={(color) => setAppearance({ color })}
							className="min-w-0 grid-cols-1"
						>
							{COLOR_THEMES.map((item) => (
								<Label
									key={item.id}
									htmlFor={`${id}-color-${item.id}`}
									className="relative flex min-w-0 cursor-pointer items-center gap-[12px] rounded-lg border border-border p-3 text-sm leading-snug transition-colors duration-150 hover:bg-muted/50 has-[[data-checked]]:border-ring has-[[data-checked]]:bg-muted/50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring motion-reduce:transition-none"
								>
									<RadioGroupItem
										id={`${id}-color-${item.id}`}
										className="absolute inset-0 size-full cursor-pointer rounded-lg opacity-0 after:hidden"
										aria-label={item.label}
										value={item.id}
									/>
									<ThemePreview theme={item.id} />
									<span className="min-w-0 flex-1 wrap-break-word font-medium">
										{item.label}
									</span>
									<span className="flex size-[20px] shrink-0 items-center justify-center text-foreground">
										{appearance.color === item.id ? (
											<Check className="size-[16px]" aria-hidden />
										) : null}
									</span>
								</Label>
							))}
						</RadioGroup>
					</fieldset>
					<fieldset>
						<legend className="mb-3 text-sm font-medium">明暗</legend>
						<RadioGroup
							aria-label="明暗"
							name="appearance-mode"
							value={theme ?? "system"}
							onValueChange={setTheme}
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
										aria-label={item.label}
										value={item.id}
									/>
									<item.icon className="size-4" aria-hidden />
									{item.label}
								</Label>
							))}
						</RadioGroup>
					</fieldset>
					<RadiusControl
						value={appearance.radius}
						onChange={(radius) => setAppearance({ radius })}
					/>
					<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
						<span className="text-xs text-muted-foreground">当前浏览器</span>
						<Button
							variant="ghost"
							className="min-h-11"
							onClick={() => {
								setAppearance(DEFAULT_APPEARANCE);
								setTheme("system");
							}}
						>
							<RotateCcw aria-hidden />
							恢复默认
						</Button>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

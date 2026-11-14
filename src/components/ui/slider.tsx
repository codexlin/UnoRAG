"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

// Adapted from shadcn/ui base-nova Slider; keep a 44px control hit area.
function Slider({
	className,
	defaultValue,
	value,
	min = 0,
	max = 100,
	getAriaLabel,
	getAriaValueText,
	...props
}: SliderPrimitive.Root.Props &
	Pick<SliderPrimitive.Thumb.Props, "getAriaLabel" | "getAriaValueText">) {
	const values = Array.isArray(value)
		? value
		: Array.isArray(defaultValue)
			? defaultValue
			: [value ?? defaultValue ?? min];
	return (
		<SliderPrimitive.Root
			className={cn("data-horizontal:w-full data-vertical:h-full", className)}
			data-slot="slider"
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			thumbAlignment="edge"
			{...props}
		>
			<SliderPrimitive.Control className="relative flex min-h-11 w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:min-w-11 data-vertical:w-auto data-vertical:flex-col">
				<SliderPrimitive.Track
					data-slot="slider-track"
					className="relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
				>
					<SliderPrimitive.Indicator
						data-slot="slider-range"
						className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
					/>
				</SliderPrimitive.Track>
				{values.map((_, index) => (
					<SliderPrimitive.Thumb
						data-slot="slider-thumb"
						// biome-ignore lint/suspicious/noArrayIndexKey: thumb identity is its ordered range position
						key={index}
						index={index}
						getAriaLabel={getAriaLabel}
						getAriaValueText={getAriaValueText}
						className="relative block size-4 shrink-0 rounded-full border border-ring bg-background ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-3 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 data-disabled:pointer-events-none data-disabled:opacity-50 motion-reduce:transition-none"
					/>
				))}
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	);
}

export { Slider };

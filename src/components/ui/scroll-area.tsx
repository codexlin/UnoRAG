"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@/lib/utils";

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
	viewportClassName?: string;
	contentClassName?: string;
	viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "children"> & {
		[key: `data-${string}`]: string | number | boolean | undefined;
	};
	orientation?: "vertical" | "horizontal" | "both";
};

function ScrollArea({
	className,
	viewportClassName,
	contentClassName,
	viewportProps,
	orientation = "vertical",
	children,
	...props
}: ScrollAreaProps) {
	const { className: extraViewportClassName, ...restViewportProps } =
		viewportProps ?? {};
	const showVertical = orientation !== "horizontal";
	const showHorizontal = orientation !== "vertical";

	return (
		<ScrollAreaPrimitive.Root
			data-slot="scroll-area"
			className={cn("relative overflow-hidden", className)}
			{...props}
		>
			<ScrollAreaPrimitive.Viewport
				data-slot="scroll-area-viewport"
				className={cn(
					"no-scrollbar size-full rounded-[inherit] overscroll-contain transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
					viewportClassName,
					extraViewportClassName,
				)}
				{...restViewportProps}
			>
				<ScrollAreaPrimitive.Content
					data-slot="scroll-area-content"
					style={showHorizontal ? undefined : { minWidth: 0 }}
					className={cn(
						showHorizontal ? "min-w-full" : "w-full min-w-0",
						contentClassName,
					)}
				>
					{children}
				</ScrollAreaPrimitive.Content>
			</ScrollAreaPrimitive.Viewport>
			{showVertical ? <ScrollBar orientation="vertical" /> : null}
			{showHorizontal ? <ScrollBar orientation="horizontal" /> : null}
			{showVertical && showHorizontal ? <ScrollAreaPrimitive.Corner /> : null}
		</ScrollAreaPrimitive.Root>
	);
}

function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
	return (
		<ScrollAreaPrimitive.Scrollbar
			data-slot="scroll-area-scrollbar"
			data-orientation={orientation}
			orientation={orientation}
			className={cn(
				"pointer-events-none z-20 flex touch-none p-0.5 opacity-0 transition-opacity duration-200 select-none motion-reduce:transition-none data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-horizontal:h-2 data-horizontal:w-full data-horizontal:flex-col data-vertical:h-full data-vertical:w-2",
				className,
			)}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb
				data-slot="scroll-area-thumb"
				className="relative flex-1 rounded-full bg-muted-foreground/35 transition-colors hover:bg-muted-foreground/55 active:bg-muted-foreground/70 motion-reduce:transition-none"
			/>
		</ScrollAreaPrimitive.Scrollbar>
	);
}

export { ScrollArea, ScrollBar };

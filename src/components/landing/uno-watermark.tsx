import { cn } from "@/lib/utils";

/** Canonical diagonal-weave outline from public/brand/uno-mark.svg. */
const UNO_MARK_PATH =
	"M194 499 377 383V729C383 809.5 422 867 493.5 873C563 870 615 829 666 772C627 782 621.5 787 595.5 787C519 787 440 724 440 623C446 564 472 500 501 451C586 269 711 191 830 191C964 197 1048 275 1060 404V731L889 838V485C898 399 850 358 801 352C718.5 349 648 395 571 479C605 465 634 458 655.5 458C753.5 446 829 547 817 625C805 765.5 716 931 593 1003C533 1036 477 1042 450.5 1042C314 1036 206 930 194 771ZM624 526C681.438 526 728 572.562 728 630C728 687.438 681.438 734 624 734C566.562 734 520 687.438 520 630C520 572.562 566.562 526 624 526Z";

type UnoWireframeProps = {
	className?: string;
	accentRing?: boolean;
};

export function UnoWireframe({
	className,
	accentRing = false,
}: UnoWireframeProps) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 128 128"
			fill="none"
			className={cn("pointer-events-none select-none", className)}
		>
			<path
				d={UNO_MARK_PATH}
				transform="translate(-16.384 -14.336) scale(.128)"
				fill="currentColor"
				fillOpacity="0.16"
				fillRule="evenodd"
				stroke="currentColor"
				strokeWidth="1.25"
				vectorEffect="non-scaling-stroke"
			/>
			{accentRing ? (
				<circle
					cx="63.488"
					cy="66.304"
					r="13.312"
					className="text-primary/28 dark:text-primary/34"
					stroke="currentColor"
					strokeWidth="1.35"
					vectorEffect="non-scaling-stroke"
				/>
			) : null}
		</svg>
	);
}

/** Precision crosshair nodes anchored at the Swiss vertical rail intersections. */
export function SectionRailNodes() {
	const node =
		"pointer-events-none absolute top-0 z-20 hidden size-3.5 -translate-y-1/2 text-muted-foreground/55 xl:block";
	return (
		<>
			<svg
				aria-hidden
				viewBox="0 0 14 14"
				className={`${node} left-[calc(50%-624px)] -translate-x-1/2`}
			>
				<path d="M7 0v14M0 7h14" stroke="currentColor" strokeWidth="1" />
			</svg>
			<svg
				aria-hidden
				viewBox="0 0 14 14"
				className={`${node} right-[calc(50%-624px)] translate-x-1/2`}
			>
				<path d="M7 0v14M0 7h14" stroke="currentColor" strokeWidth="1" />
			</svg>
		</>
	);
}

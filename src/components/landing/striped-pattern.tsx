import { useId } from "react";
import { cn } from "@/lib/utils";

type StripedPatternProps = {
	direction?: "left" | "right";
	width?: number;
	height?: number;
	strokeWidth?: number;
	className?: string;
};

/**
 * Crisp inline SVG diagonal stripe pattern (MIT-compatible, zero runtime deps).
 * Uses `currentColor` so stripes adapt automatically across all color themes and light/dark modes.
 */
export function StripedPattern({
	direction = "left",
	width = 10,
	height = 10,
	strokeWidth = 1,
	className,
}: StripedPatternProps) {
	const id = useId();
	const w = width;
	const h = height;

	return (
		<svg
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-0 h-full w-full select-none",
				className,
			)}
			xmlns="http://www.w3.org/2000/svg"
		>
			<defs>
				<pattern id={id} width={w} height={h} patternUnits="userSpaceOnUse">
					{direction === "left" ? (
						<>
							<line
								x1="0"
								y1={h}
								x2={w}
								y2="0"
								stroke="currentColor"
								strokeWidth={strokeWidth}
							/>
							<line
								x1={-w}
								y1={h}
								x2={w}
								y2={-h}
								stroke="currentColor"
								strokeWidth={strokeWidth}
							/>
							<line
								x1="0"
								y1={h * 2}
								x2={w * 2}
								y2="0"
								stroke="currentColor"
								strokeWidth={strokeWidth}
							/>
						</>
					) : (
						<>
							<line
								x1="0"
								y1="0"
								x2={w}
								y2={h}
								stroke="currentColor"
								strokeWidth={strokeWidth}
							/>
							<line
								x1={-w}
								y1="0"
								x2={w}
								y2={h * 2}
								stroke="currentColor"
								strokeWidth={strokeWidth}
							/>
							<line
								x1="0"
								y1={-h}
								x2={w * 2}
								y2={h}
								stroke="currentColor"
								strokeWidth={strokeWidth}
							/>
						</>
					)}
				</pattern>
			</defs>
			<rect width="100%" height="100%" fill={`url(#${id})`} />
		</svg>
	);
}

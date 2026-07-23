import { cn } from "@/lib/utils";

type MeriKnowLogoProps = {
	className?: string;
	/** Icon-only mark size. */
	size?: "sm" | "md" | "lg";
	/** Show wordmark beside the mark. */
	withWordmark?: boolean;
	wordmarkClassName?: string;
};

const sizeClass = {
	sm: "size-6",
	md: "size-8",
	lg: "size-11",
} as const;

/**
 * MeriKnow mark — stable triangle shell with a spider-web knowledge graph inside.
 * Hub node highlighted in cite color (the verifiable point).
 */
export function MeriKnowMark({
	className,
	decorative = true,
}: {
	className?: string;
	decorative?: boolean;
}) {
	return (
		<svg
			viewBox="0 0 32 32"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={cn("shrink-0", className)}
			aria-hidden={decorative ? true : undefined}
			role={decorative ? undefined : "img"}
			aria-label={decorative ? undefined : "MeriKnow"}
		>
			{/* Stable triangle shell */}
			<path
				d="M16 3.6 28.4 26.6H3.6L16 3.6Z"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinejoin="round"
			/>

			{/* Spider-web rings (nested triangles) */}
			<path
				d="M16 7.2 25.6 24.6H6.4L16 7.2Z"
				stroke="currentColor"
				strokeWidth="1.05"
				strokeLinejoin="round"
				className="opacity-40"
			/>
			<path
				d="M16 11.4 22.4 22.6H9.6L16 11.4Z"
				stroke="currentColor"
				strokeWidth="1.05"
				strokeLinejoin="round"
				className="opacity-40"
			/>
			<path
				d="M16 15.2 19.4 20.8H12.6L16 15.2Z"
				stroke="currentColor"
				strokeWidth="1.05"
				strokeLinejoin="round"
				className="opacity-35"
			/>

			{/* Radial spokes — vertex + edge midpoints */}
			<path
				d="M16 17.2V7.2M16 17.2 25.6 24.6M16 17.2 6.4 24.6M16 17.2 21 15.9M16 17.2 11 15.9M16 17.2V24.6"
				stroke="currentColor"
				strokeWidth="1.05"
				strokeLinecap="round"
				className="opacity-40"
			/>

			{/* Web nodes */}
			<circle
				cx="16"
				cy="7.2"
				r="1.2"
				fill="currentColor"
				className="opacity-70"
			/>
			<circle
				cx="25.6"
				cy="24.6"
				r="1.2"
				fill="currentColor"
				className="opacity-70"
			/>
			<circle
				cx="6.4"
				cy="24.6"
				r="1.2"
				fill="currentColor"
				className="opacity-70"
			/>
			<circle
				cx="16"
				cy="11.4"
				r="1.15"
				fill="currentColor"
				className="opacity-65"
			/>
			<circle
				cx="22.4"
				cy="22.6"
				r="1.15"
				fill="currentColor"
				className="opacity-65"
			/>
			<circle
				cx="9.6"
				cy="22.6"
				r="1.15"
				fill="currentColor"
				className="opacity-65"
			/>
			<circle
				cx="21"
				cy="15.9"
				r="1.1"
				fill="currentColor"
				className="opacity-60"
			/>
			<circle
				cx="11"
				cy="15.9"
				r="1.1"
				fill="currentColor"
				className="opacity-60"
			/>
			<circle
				cx="16"
				cy="24.6"
				r="1.1"
				fill="currentColor"
				className="opacity-60"
			/>
			<circle
				cx="19.4"
				cy="20.8"
				r="1"
				fill="currentColor"
				className="opacity-55"
			/>
			<circle
				cx="12.6"
				cy="20.8"
				r="1"
				fill="currentColor"
				className="opacity-55"
			/>

			{/* Hub — cite-verified knowledge node */}
			<circle cx="16" cy="17.2" r="2.35" fill="currentColor" />
			<circle
				cx="16"
				cy="17.2"
				r="3.45"
				stroke="var(--cite)"
				strokeWidth="1.35"
			/>
			<circle cx="16" cy="17.2" r="1.2" fill="var(--cite)" />
		</svg>
	);
}

export function MeriKnowLogo({
	className,
	size = "md",
	withWordmark = false,
	wordmarkClassName,
}: MeriKnowLogoProps) {
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
			<MeriKnowMark
				className={cn(sizeClass[size], "text-primary")}
				decorative={withWordmark}
			/>
			{withWordmark ? (
				<span
					className={cn(
						"font-heading text-lg font-semibold tracking-tight text-primary",
						wordmarkClassName,
					)}
				>
					MeriKnow
				</span>
			) : null}
		</span>
	);
}

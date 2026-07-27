import Image from "next/image";

import { cn } from "@/lib/utils";

/** Primary brand mark asset (black-square MK monogram). */
export const MERIKNOW_MARK_SRC = "/brand/meriknow-mark.png";

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
 * MeriKnow mark — stylized MK monogram on black (brand PNG).
 */
export function MeriKnowMark({
	className,
	decorative = true,
}: {
	className?: string;
	decorative?: boolean;
}) {
	return (
		<Image
			src={MERIKNOW_MARK_SRC}
			alt={decorative ? "" : "MeriKnow"}
			title={decorative ? undefined : "MeriKnow"}
			width={150}
			height={150}
			draggable={false}
			className={cn("shrink-0 rounded-md object-cover", className)}
			aria-hidden={decorative ? true : undefined}
		/>
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
			<MeriKnowMark className={cn(sizeClass[size])} decorative={withWordmark} />
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

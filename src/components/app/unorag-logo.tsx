import Image from "next/image";

import { cn } from "@/lib/utils";

/** Primary UnoRAG brand mark asset. */
export const UNORAG_MARK_SRC = "/brand/unorag-mark.svg";

type UnoRAGLogoProps = {
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

/** UnoRAG U-shaped knowledge graph mark. */
export function UnoRAGMark({
	className,
	decorative = true,
}: {
	className?: string;
	decorative?: boolean;
}) {
	return (
		<Image
			src={UNORAG_MARK_SRC}
			alt={decorative ? "" : "UnoRAG"}
			title={decorative ? undefined : "UnoRAG"}
			width={128}
			height={128}
			draggable={false}
			className={cn("shrink-0 rounded-md object-cover", className)}
			aria-hidden={decorative ? true : undefined}
		/>
	);
}

export function UnoRAGLogo({
	className,
	size = "md",
	withWordmark = false,
	wordmarkClassName,
}: UnoRAGLogoProps) {
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
			<UnoRAGMark className={cn(sizeClass[size])} decorative={withWordmark} />
			{withWordmark ? (
				<span
					className={cn(
						"font-heading text-lg font-semibold tracking-tight text-primary",
						wordmarkClassName,
					)}
				>
					UnoRAG
				</span>
			) : null}
		</span>
	);
}

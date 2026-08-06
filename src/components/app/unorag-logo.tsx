import Image from "next/image";

import { cn } from "@/lib/utils";

/** Canonical mark shared by the Uno product family. */
const UNO_MARK_SRC = "/brand/uno-mark.svg";

type UnoLogoProps = {
	className?: string;
	/** Icon-only mark size. */
	size?: "sm" | "md" | "lg";
	/** Product suffix appended to the stable Uno mother brand. */
	suffix?: string;
	wordmarkClassName?: string;
};

const sizeClass = {
	sm: "size-6",
	md: "size-8",
	lg: "size-11",
} as const;

/** Continuous U-N-O mother-brand mark. */
export function UnoMark({
	className,
	decorative = true,
	label = "Uno",
}: {
	className?: string;
	decorative?: boolean;
	label?: string;
}) {
	return (
		<Image
			src={UNO_MARK_SRC}
			alt={decorative ? "" : label}
			title={decorative ? undefined : label}
			width={128}
			height={128}
			draggable={false}
			className={cn("shrink-0 rounded-md object-cover", className)}
			aria-hidden={decorative ? true : undefined}
		/>
	);
}

export function UnoLogo({
	className,
	size = "md",
	suffix,
	wordmarkClassName,
}: UnoLogoProps) {
	const label = `Uno${suffix ?? ""}`;

	return (
		<span
			className={cn("inline-flex min-w-0 items-center gap-2.5", className)}
			role="img"
			aria-label={label}
		>
			<UnoMark className={cn(sizeClass[size])} decorative />
			{suffix !== undefined ? (
				<span
					className={cn(
						"font-heading text-lg font-semibold tracking-normal text-foreground",
						wordmarkClassName,
					)}
					aria-hidden
				>
					Uno<span className="text-primary">{suffix}</span>
				</span>
			) : null}
		</span>
	);
}

/** Backward-compatible UnoRAG icon export. */
export function UnoRAGMark(props: React.ComponentProps<typeof UnoMark>) {
	return <UnoMark {...props} label="UnoRAG" />;
}

export function UnoRAGLogo({
	withWordmark = false,
	...props
}: Omit<UnoLogoProps, "suffix"> & { withWordmark?: boolean }) {
	return <UnoLogo {...props} suffix={withWordmark ? "RAG" : undefined} />;
}

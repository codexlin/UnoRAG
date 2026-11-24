"use client";

import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp";
import { Minus } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

function InputOTP({
	className,
	containerClassName,
	...props
}: React.ComponentProps<typeof OTPInput> & {
	containerClassName?: string;
}) {
	return (
		<OTPInput
			data-slot="input-otp"
			containerClassName={cn(
				"cn-input-otp flex items-center gap-2 has-disabled:opacity-50",
				containerClassName,
			)}
			spellCheck={false}
			className={cn("text-base disabled:cursor-not-allowed", className)}
			{...props}
		/>
	);
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="input-otp-group"
			className={cn(
				"flex min-w-0 items-center rounded-lg has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	);
}

function InputOTPSlot({
	index,
	className,
	...props
}: React.ComponentProps<"div"> & {
	index: number;
}) {
	const inputOTPContext = React.useContext(OTPInputContext);
	const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

	return (
		<div
			data-slot="input-otp-slot"
			data-active={isActive}
			className={cn(
				"relative flex h-11 w-10 items-center justify-center border-y border-r border-input bg-background font-mono text-base font-medium shadow-2xs transition-[border-color,box-shadow,background-color] duration-150 outline-none first:rounded-l-lg first:border-l last:rounded-r-lg aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-3 data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:border-destructive data-[active=true]:aria-invalid:ring-destructive/20 dark:bg-muted/35 dark:data-[active=true]:aria-invalid:ring-destructive/40 motion-reduce:transition-none",
				className,
			)}
			{...props}
		>
			{char}
			{hasFakeCaret ? (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div className="h-4 w-px animate-caret-blink bg-foreground duration-1000 motion-reduce:animate-none" />
				</div>
			) : null}
		</div>
	);
}

function InputOTPSeparator({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="input-otp-separator"
			className={cn(
				"flex shrink-0 items-center text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			aria-hidden="true"
			{...props}
		>
			<Minus />
		</div>
	);
}

export {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
	REGEXP_ONLY_DIGITS,
};

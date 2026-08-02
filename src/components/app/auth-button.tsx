"use client";

import type { ComponentProps } from "react";

import { Can } from "@/components/app/can";
import { Button } from "@/components/ui/button";
import type { CapExpr } from "@/lib/client-permissions";

type AuthButtonProps = ComponentProps<typeof Button> & {
	cap: CapExpr;
	when?: boolean;
};

/** Button that is omitted from the tree when capability is missing. */
export function AuthButton({ cap, when, ...buttonProps }: AuthButtonProps) {
	return (
		<Can cap={cap} when={when}>
			<Button {...buttonProps} />
		</Can>
	);
}

"use client";

import { Languages } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setInterfaceLanguage } from "@/lib/i18n/language-action";
import { isLocale } from "@/lib/i18n/locale";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";

export function LanguageMenu() {
	const { preference } = useInterfaceLanguage();
	const t = useInterfaceText();
	const [pending, startTransition] = useTransition();
	const label = t("界面语言", "Interface language");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				title={label}
				disabled={pending}
				render={<Button variant="ghost" size="icon" className="size-11" />}
			>
				<Languages aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-36">
				<DropdownMenuRadioGroup
					value={preference}
					onValueChange={(value) => {
						if (
							value === preference ||
							(!isLocale(value) && value !== "system")
						)
							return;
						startTransition(async () => {
							try {
								if (!(await setInterfaceLanguage(value))) throw new Error();
							} catch {
								toast.error(
									t(
										"无法保存语言偏好",
										"Couldn't save the language preference",
									),
								);
							}
						});
					}}
				>
					<DropdownMenuRadioItem value="system">
						{t("跟随系统", "Use system language")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="en" lang="en">
						English
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="zh-CN" lang="zh-CN">
						简体中文
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

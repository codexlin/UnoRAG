import { Suspense } from "react";

import { AskWorkspace } from "@/components/app/ask/ask-workspace";
import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";

export default async function AskPage() {
	const t = interfaceText((await getRequestLanguage()).locale);
	return (
		<Suspense
			fallback={
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
					{t("加载问答…", "Loading Ask…")}
				</div>
			}
		>
			<AskWorkspace />
		</Suspense>
	);
}

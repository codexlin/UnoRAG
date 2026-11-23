import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";

export default async function AppLoading() {
	const t = interfaceText((await getRequestLanguage()).locale);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-6 sm:px-6 lg:px-8">
			<p className="sr-only" role="status">
				{t("正在加载页面", "Loading page")}
			</p>
			<div className="h-4 w-28 animate-pulse rounded-sm bg-muted" />
			<div className="h-8 w-56 animate-pulse rounded-sm bg-muted" />
			<div className="mt-2 min-h-64 flex-1 animate-pulse rounded-md border border-border/70 bg-card/60" />
		</div>
	);
}

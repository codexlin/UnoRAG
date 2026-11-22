import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";
import { IngestJobsProvider } from "@/components/app/ingest-jobs-provider";
import { NavigationGuardProvider } from "@/components/app/navigation-guard";
import { QueryProvider } from "@/components/app/query-provider";
import { SessionProvider } from "@/components/app/session-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";
import { resolveSessionCookieHeader } from "@/lib/server/auth/session";
import type { SessionIdentity } from "@/lib/session-types";

export default async function AppLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const cookieStore = await cookies();
	const identity = await resolveSessionCookieHeader(cookieStore.toString());
	if (!identity) redirect("/login");
	if (identity.mustChangePassword) redirect("/change-password");
	const t = interfaceText((await getRequestLanguage()).locale);

	const session: SessionIdentity = {
		tenantId: identity.tenantId,
		workspaceId: identity.workspaceId,
		workspaceName: identity.workspaceName,
		principalId: identity.principalId,
		groupIds: identity.groupIds,
		organizationRole: identity.organizationRole,
		role: identity.role,
		email: identity.email,
		displayName: identity.displayName,
		provider: identity.provider,
		mustChangePassword: identity.mustChangePassword,
	};

	return (
		<SessionProvider key={session.workspaceId} identity={session}>
			<QueryProvider>
				<NavigationGuardProvider>
					<IngestJobsProvider>
						<TooltipProvider>
							<SidebarProvider
								defaultOpen={cookieStore.get("sidebar_state")?.value === "true"}
								className="h-dvh min-h-0! overflow-hidden bg-background"
								style={
									{
										"--sidebar-width": "13rem",
										"--sidebar-width-icon": "3.5rem",
									} as React.CSSProperties
								}
							>
								<a
									href="#workspace-content"
									className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-3 focus:text-sm focus:text-foreground focus:outline-2 focus:outline-ring"
								>
									{t("跳至主要内容", "Skip to main content")}
								</a>
								<AppSidebar />
								<SidebarInset className="min-h-0 overflow-hidden bg-transparent">
									<AppTopbar />
									<div
										id="workspace-content"
										tabIndex={-1}
										className="flex min-h-0 flex-1 flex-col overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
									>
										{children}
									</div>
								</SidebarInset>
							</SidebarProvider>
						</TooltipProvider>
					</IngestJobsProvider>
				</NavigationGuardProvider>
			</QueryProvider>
		</SessionProvider>
	);
}

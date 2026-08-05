import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";
import { IngestJobsProvider } from "@/components/app/ingest-jobs-provider";
import { QueryProvider } from "@/components/app/query-provider";
import { SessionProvider } from "@/components/app/session-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
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
	};

	return (
		<SessionProvider key={session.workspaceId} identity={session}>
			<QueryProvider>
				<IngestJobsProvider>
					<TooltipProvider>
						<SidebarProvider
							className="h-dvh min-h-0! overflow-hidden bg-background/40"
							style={
								{
									"--sidebar-width": "16rem",
									"--sidebar-width-icon": "3.5rem",
								} as React.CSSProperties
							}
						>
							<AppSidebar />
							<SidebarInset className="min-h-0 overflow-hidden bg-transparent">
								<AppTopbar />
								<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
									{children}
								</div>
							</SidebarInset>
						</SidebarProvider>
					</TooltipProvider>
				</IngestJobsProvider>
			</QueryProvider>
		</SessionProvider>
	);
}

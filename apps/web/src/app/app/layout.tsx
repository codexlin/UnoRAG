import { AppDataProvider } from "@/components/app/app-data-provider";
import { AppSidebar } from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";
import { IngestJobsProvider } from "@/components/app/ingest-jobs-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveSessionCookieHeader } from "@/lib/server/auth/session";

export default async function AppLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const cookieStore = await cookies();
	const identity = await resolveSessionCookieHeader(cookieStore.toString());
	if (!identity) redirect("/login");

	return (
		<AppDataProvider>
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
							<div className="flex min-h-0 flex-1 flex-col">{children}</div>
						</SidebarInset>
					</SidebarProvider>
				</TooltipProvider>
			</IngestJobsProvider>
		</AppDataProvider>
	);
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";

export default function AppLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<div className="flex h-dvh min-h-0 overflow-hidden bg-background/40">
			<AppSidebar />
			<div className="flex min-w-0 flex-1 flex-col">
				<AppTopbar />
				<main className="flex min-h-0 flex-1 flex-col">{children}</main>
			</div>
		</div>
	);
}

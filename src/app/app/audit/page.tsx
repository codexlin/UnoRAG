import { WorkspaceAuditPanel } from "@/components/app/workspace-audit-panel";

export default function AuditPage() {
	return (
		<div className="flex min-w-0 flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
			<div className="mx-auto w-full max-w-7xl space-y-6">
				<header className="border-border/80 border-b pb-5">
					<h2 className="text-2xl font-medium">操作记录</h2>
				</header>
				<WorkspaceAuditPanel />
			</div>
		</div>
	);
}

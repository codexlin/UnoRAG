import { WorkspaceAuditPanel } from "@/components/app/workspace-audit-panel";

export default function AuditPage() {
	return (
		<div className="flex flex-1 flex-col px-5 py-7 sm:px-6 lg:px-8 lg:py-9">
			<div className="mx-auto w-full max-w-7xl space-y-6">
				<header className="border-border/80 border-b pb-5">
					<p className="text-meta font-mono tracking-[0.2em] text-cite uppercase">
						Audit
					</p>
					<h2 className="mt-1 font-heading text-2xl font-semibold">操作记录</h2>
					<p className="text-ui mt-1 text-muted-foreground">
						按工作区追溯操作者、业务动作、资源和请求标识。执行阶段与性能数据请在运行中心查看。
					</p>
				</header>
				<WorkspaceAuditPanel fullPage />
			</div>
		</div>
	);
}

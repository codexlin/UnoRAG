export default function SettingsPage() {
	return (
		<div className="flex flex-1 items-start justify-center px-5 py-16">
			<div className="max-w-md space-y-3 text-center">
				<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
					Settings
				</p>
				<h2 className="font-heading text-2xl font-semibold tracking-tight">
					工作区设置
				</h2>
				<p className="text-sm leading-6 text-muted-foreground">
					后续放置模型、检索阈值与服务健康状态。当前顶栏「API
					待接入」即占位信号。
				</p>
			</div>
		</div>
	);
}

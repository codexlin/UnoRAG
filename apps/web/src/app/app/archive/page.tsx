export default function ArchivePage() {
	return (
		<div className="flex flex-1 items-start justify-center px-5 py-16">
			<div className="max-w-md space-y-3 text-center">
				<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
					Archive
				</p>
				<h2 className="font-heading text-2xl font-semibold tracking-tight">
					档案台即将就绪
				</h2>
				<p className="text-sm leading-6 text-muted-foreground">
					这里会回看历史问答与当时引用的证据片段。先把问答台与 API
					接通后，再接入会话持久化。
				</p>
			</div>
		</div>
	);
}

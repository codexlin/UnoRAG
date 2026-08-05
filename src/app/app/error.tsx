"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function AppError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("app_route_error", error);
	}, [error]);

	return (
		<div className="grid min-h-0 flex-1 place-items-center px-6 py-12">
			<div className="w-full max-w-md border-l-2 border-l-destructive bg-card px-5 py-5">
				<div className="flex items-center gap-2 text-destructive">
					<TriangleAlert className="size-4" aria-hidden />
					<p className="font-mono text-xs tracking-[0.14em] uppercase">
						Workspace error
					</p>
				</div>
				<h2 className="mt-3 text-lg font-semibold">当前页面未能正常加载</h2>
				<p className="mt-2 text-sm leading-6 text-muted-foreground">
					可以重试当前页面。若问题持续出现，请在运行中心按请求时间检查服务状态。
				</p>
				{error.digest ? (
					<p className="mt-3 font-mono text-xs text-muted-foreground">
						错误编号：{error.digest}
					</p>
				) : null}
				<Button className="mt-5" variant="outline" onClick={reset}>
					<RotateCcw data-icon="inline-start" />
					重试
				</Button>
			</div>
		</div>
	);
}

import { FileUp, Plus } from "lucide-react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { MOCK_LIBRARIES } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const statusLabel = {
	ready: "就绪",
	indexing: "索引中",
	empty: "空库",
} as const;

export function LibrariesPanel() {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div className="space-y-1">
						<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
							Libraries
						</p>
						<h2 className="font-heading text-2xl font-semibold tracking-tight">
							文库
						</h2>
						<p className="max-w-lg text-sm leading-6 text-muted-foreground">
							先建库、再收录资料。当前为 mock 列表，上传与解析将在 API
							接入后接通。
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							className="rounded-md"
							disabled
						>
							<FileUp data-icon="inline-start" />
							上传（即将）
						</Button>
						<Button type="button" className="rounded-md" disabled>
							<Plus data-icon="inline-start" />
							新建文库
						</Button>
					</div>
				</div>

				<ul className="grid gap-3 sm:grid-cols-2">
					{MOCK_LIBRARIES.map((library) => (
						<li key={library.id}>
							<Card className="border-border/80 bg-card/90 shadow-sm transition-colors hover:border-border">
								<CardHeader className="gap-1.5">
									<div className="flex items-center justify-between gap-2">
										<CardTitle className="font-heading text-lg">
											{library.name}
										</CardTitle>
										<span
											className={cn(
												"rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase",
												library.status === "ready" &&
													"border-cite/30 bg-cite/10 text-cite",
												library.status === "indexing" &&
													"border-survey/35 bg-accent text-accent-foreground",
												library.status === "empty" &&
													"border-border bg-muted text-muted-foreground",
											)}
										>
											{statusLabel[library.status]}
										</span>
									</div>
									<CardDescription>
										{library.readyCount}/{library.docCount} 文档就绪 · 更新于{" "}
										{library.updatedAt}
									</CardDescription>
								</CardHeader>
								<CardContent>
									<Link
										href="/app/ask"
										className={cn(
											buttonVariants({ variant: "outline", size: "sm" }),
											"rounded-md",
										)}
									>
										在问答台打开
									</Link>
								</CardContent>
							</Card>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

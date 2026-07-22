import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default function Home() {
	return (
		<main className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-8 px-6 py-16">
			<div className="space-y-3">
				<p className="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
					MeriKnow
				</p>
				<h1 className="text-4xl font-semibold tracking-tight text-foreground">
					有据可依的企业知识问答
				</h1>
				<p className="max-w-xl text-base leading-7 text-muted-foreground">
					融合 DustyKB 的可上线体验与 QueryNest 的多步编排思路，后端将采用 LangChain
					+ LangGraph。当前为 Web 脚手架阶段（Next.js · pnpm · shadcn · Biome）。
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Phase 0 已就绪</CardTitle>
					<CardDescription>
						计划文档见仓库 docs/plans/2026-07-22-meriknow-bootstrap.md
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-3">
					<Button type="button">开始构建</Button>
					<Link
						className={cn(buttonVariants({ variant: "outline" }))}
						href="https://ui.shadcn.com"
						target="_blank"
						rel="noreferrer"
					>
						shadcn/ui
					</Link>
				</CardContent>
			</Card>
		</main>
	);
}

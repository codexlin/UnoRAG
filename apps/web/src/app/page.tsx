import Link from "next/link";

import { MeriKnowLogo } from "@/components/app/meriknow-logo";
import { buttonVariants } from "@/components/ui/button";
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
		<main className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col gap-12 px-6 py-16 md:py-24">
			<header className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-3">
					<MeriKnowLogo size="lg" withWordmark wordmarkClassName="text-2xl" />
					<span className="text-meta hidden font-mono tracking-[0.18em] text-muted-foreground uppercase sm:inline">
						Northline
					</span>
				</div>
				<span className="font-mono text-[11px] tracking-wide text-muted-foreground">
					v0 · scaffold
				</span>
			</header>

			<section className="grid gap-10 md:grid-cols-[1.2fr_0.8fr] md:items-end">
				<div className="space-y-5">
					<p className="font-mono text-xs tracking-[0.22em] text-cite uppercase">
						有据可依 · 循迹可核
					</p>
					<h1 className="font-heading max-w-xl text-4xl leading-[1.15] font-semibold tracking-tight text-foreground md:text-5xl">
						企业知识问答，
						<br />
						像测绘一样对准出处。
					</h1>
					<p className="max-w-lg text-base leading-7 text-muted-foreground">
						MeriKnow 面向团队知识库：检索有据、引用可循、编排可演进。主题
						<strong className="font-medium text-foreground"> Northline </strong>
						用冷静的海青与批注轨，区别于常见的紫渐变 AI 仪表盘。
					</p>
					<div className="flex flex-wrap gap-3 pt-1">
						<Link
							href="/app/ask"
							className={cn(buttonVariants(), "rounded-md")}
						>
							进入工作台
						</Link>
						<Link
							className={cn(
								buttonVariants({ variant: "outline" }),
								"rounded-md",
							)}
							href="https://github.com/codexlin/MeriKnow"
							target="_blank"
							rel="noreferrer"
						>
							GitHub
						</Link>
					</div>
				</div>

				<Card className="border-border/80 bg-card/90 shadow-[0_12px_40px_-24px_rgba(11,28,36,0.45)] backdrop-blur-sm">
					<CardHeader className="gap-2">
						<CardDescription className="font-mono text-[11px] tracking-[0.16em] uppercase">
							Citation preview
						</CardDescription>
						<CardTitle className="font-heading text-xl">引用长这样</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="cite-rail space-y-2 rounded-md bg-background/70 py-3 pr-3">
							<p className="font-mono text-[11px] text-cite">
								[1] · handbook.pdf · p.12
							</p>
							<p className="text-sm leading-6 text-foreground/90">
								病假须于返岗后三个工作日内补交证明材料，并由直属主管确认……
							</p>
						</div>
						<div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3 font-mono text-[11px] text-muted-foreground">
							<span>
								accent <span className="survey-mark">■</span> survey
							</span>
							<span>cite ■ teal</span>
						</div>
					</CardContent>
				</Card>
			</section>

			<section className="grid gap-4 sm:grid-cols-3">
				{[
					{
						title: "证据优先",
						body: "答案旁挂引用轨，先核对出处再采信结论。",
					},
					{
						title: "日间友好",
						body: "冷雾底色 + 深海青主色，适合长时间办公阅读。",
					},
					{
						title: "可演进编排",
						body: "UI 克制；多步 Agent 能力留给 LangGraph 后端。",
					},
				].map((item) => (
					<div
						key={item.title}
						className="rounded-md border border-border/80 bg-card/70 p-4 shadow-sm"
					>
						<h2 className="font-heading text-lg font-semibold text-foreground">
							{item.title}
						</h2>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							{item.body}
						</p>
					</div>
				))}
			</section>
		</main>
	);
}

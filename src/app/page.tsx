import {
	ArrowRight,
	Braces,
	Check,
	Database,
	type FileStack,
	GitBranch,
	LockKeyhole,
	ScanSearch,
	ServerCog,
	ShieldCheck,
	TableProperties,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const capabilities = [
	{
		icon: ScanSearch,
		label: "Document intelligence",
		title: "复杂资料，不只提取文字",
		body: "DocumentIR 与 TableIR 保留章节、页码、表头、单位和来源坐标；扫描与复杂 PDF 可按策略进入 MinerU。",
	},
	{
		icon: ShieldCheck,
		label: "Security boundary",
		title: "检索之前，先验证权限",
		body: "Organization、Workspace、Library、版本与 ACL 共同进入召回过滤，跨空间泄漏是发布熔断项。",
	},
	{
		icon: GitBranch,
		label: "Answer graph",
		title: "回答是一条可观测链路",
		body: "Query Router、检索计划、证据裁决、拒答与生成由 LangGraph 编排，关键阶段可以沿 trace 复盘。",
	},
	{
		icon: TableProperties,
		label: "Table evidence",
		title: "表格答案回到命中行",
		body: "中小表按原表、摘要与行组分层索引；比较、单位和条件查询保留命中行引用，而不是只给模糊摘要。",
	},
] as const;

const workflow = [
	["01", "接入资料", "TXT、Markdown、PDF、DOCX"],
	["02", "解析建模", "结构、表格、页面坐标与质量报告"],
	["03", "治理索引", "ACL、版本、Job、原子激活与隔离门禁"],
	["04", "有据回答", "检索、裁决、拒答、引用与链路追踪"],
] as const;

export default function Home() {
	return (
		<main className="min-h-full bg-background text-foreground">
			<section className="relative isolate min-h-[660px] overflow-hidden border-b border-border/80 md:min-h-[min(760px,78svh)]">
				<Image
					src="/landing-evidence-desk.png"
					alt="带有证据标签的企业文档、表格与审阅资料"
					fill
					priority
					sizes="100vw"
					className="object-cover object-[68%_center]"
				/>
				<div
					className="absolute inset-0 bg-white/48 sm:bg-white/18"
					aria-hidden
				/>

				<header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8 lg:px-10">
					<UnoRAGLogo
						size="lg"
						withWordmark
						wordmarkClassName="text-xl text-[#172025]"
					/>
					<div className="flex items-center gap-2">
						<span className="hidden font-mono text-[11px] text-[#435158] sm:inline">
							PRIVATE DEPLOYMENT · V1
						</span>
						<Link
							href="/app/ask"
							className={cn(
								buttonVariants({ variant: "outline", size: "sm" }),
								"border-[#aeb9bd] bg-white/80 text-[#172025] shadow-sm backdrop-blur-sm hover:bg-white",
							)}
						>
							进入工作台
						</Link>
					</div>
				</header>

				<div className="relative z-10 mx-auto flex w-full max-w-7xl px-5 pt-24 pb-14 sm:px-8 md:pt-28 lg:px-10">
					<div className="max-w-2xl">
						<p className="font-mono text-xs tracking-[0.18em] text-[#087a6a] uppercase">
							Enterprise Knowledge Infrastructure
						</p>
						<h1 className="font-brand mt-5 text-6xl leading-none font-semibold text-[#172025] sm:text-7xl">
							UnoRAG
						</h1>
						<p className="mt-6 max-w-xl text-2xl leading-9 font-medium text-[#172025] sm:text-3xl sm:leading-11">
							把企业资料变成
							<br />
							可治理、可核验的知识服务。
						</p>
						<p className="mt-5 max-w-lg text-base leading-7 text-[#435158]">
							私有化部署的企业知识基础设施。统一文档生命周期、权限隔离、复杂解析、检索与有据回答，并通过
							Workspace 与稳定 API 接入真实业务。
						</p>
						<div className="mt-8 flex flex-wrap gap-3">
							<Link href="/app/ask" className={buttonVariants({ size: "lg" })}>
								体验证据工作台
								<ArrowRight data-icon="inline-end" />
							</Link>
							<Link
								href="https://github.com/codexlin/UnoRAG"
								target="_blank"
								rel="noreferrer"
								className={cn(
									buttonVariants({ variant: "outline", size: "lg" }),
									"border-[#aeb9bd] bg-white/75 text-[#172025] backdrop-blur-sm hover:bg-white",
								)}
							>
								查看源码
							</Link>
						</div>
						<div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] text-[#435158]">
							{["本地或客户云", "Workspace 隔离", "引用可回原文"].map(
								(item) => (
									<span key={item} className="inline-flex items-center gap-1.5">
										<Check className="size-3.5 text-[#087a6a]" aria-hidden />
										{item}
									</span>
								),
							)}
						</div>
					</div>
				</div>
			</section>

			<section className="border-b border-border/80 bg-card">
				<div className="mx-auto grid max-w-7xl md:grid-cols-[0.8fr_1.2fr]">
					<div className="border-b border-border/80 px-5 py-12 sm:px-8 md:border-r md:border-b-0 lg:px-10 lg:py-16">
						<p className="font-mono text-[11px] tracking-[0.16em] text-cite uppercase">
							Why UnoRAG
						</p>
						<h2 className="mt-3 max-w-md text-3xl leading-10 font-semibold">
							不是另一个聊天框，
							<br />
							而是一条完整的知识生产线。
						</h2>
					</div>
					<div className="grid sm:grid-cols-2">
						{capabilities.map((item, index) => {
							const Icon = item.icon;
							return (
								<article
									key={item.title}
									className={cn(
										"px-5 py-8 sm:px-7 lg:px-8 lg:py-10",
										index % 2 === 1 && "sm:border-l sm:border-border/80",
										index > 1 && "border-t border-border/80",
										index === 1 && "border-t border-border/80 sm:border-t-0",
									)}
								>
									<div className="flex items-center gap-2 text-cite">
										<Icon className="size-4" aria-hidden />
										<span className="font-mono text-[11px] uppercase">
											{item.label}
										</span>
									</div>
									<h3 className="mt-4 text-lg font-semibold">{item.title}</h3>
									<p className="mt-2 text-sm leading-6 text-muted-foreground">
										{item.body}
									</p>
								</article>
							);
						})}
					</div>
				</div>
			</section>

			<section className="border-b border-border/80">
				<div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 lg:px-10 lg:py-20">
					<div className="flex flex-wrap items-end justify-between gap-5">
						<div>
							<p className="font-mono text-[11px] tracking-[0.16em] text-cite uppercase">
								One governed flow
							</p>
							<h2 className="mt-3 text-3xl font-semibold">
								从文件到答案，每一步都有边界
							</h2>
						</div>
						<p className="max-w-lg text-sm leading-6 text-muted-foreground">
							控制面负责身份、资料、版本与任务；数据面负责解析、检索与回答。两者共享同一
							RequestContext，不产生第二套权限事实。
						</p>
					</div>

					<ol className="mt-10 grid border border-border/80 bg-card sm:grid-cols-2 lg:grid-cols-4">
						{workflow.map(([index, title, body], itemIndex) => (
							<li
								key={index}
								className={cn(
									"min-h-44 px-5 py-6",
									itemIndex > 0 && "border-t border-border/80 sm:border-t-0",
									itemIndex % 2 === 1 && "sm:border-l sm:border-border/80",
									itemIndex > 1 &&
										"sm:border-t sm:border-border/80 lg:border-t-0",
									itemIndex > 0 && "lg:border-l lg:border-border/80",
								)}
							>
								<span className="font-mono text-xs text-cite">{index}</span>
								<h3 className="mt-8 text-lg font-semibold">{title}</h3>
								<p className="mt-2 text-sm leading-6 text-muted-foreground">
									{body}
								</p>
							</li>
						))}
					</ol>
				</div>
			</section>

			<section className="border-b border-border/80 bg-card">
				<div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 lg:px-10 lg:py-20">
					<div className="grid gap-5 md:grid-cols-[0.75fr_1.25fr] md:items-end">
						<div>
							<p className="font-mono text-[11px] tracking-[0.16em] text-cite uppercase">
								Operator workspace
							</p>
							<h2 className="mt-3 text-3xl leading-10 font-semibold">
								为持续治理而设计，
								<br />
								不是一次性上传器。
							</h2>
						</div>
						<p className="max-w-xl text-sm leading-7 text-muted-foreground">
							资料空间、解析策略、版本、任务状态与文档台账集中在同一工作面。管理员看得到异常，
							普通成员只看到与职责相关的动作。
						</p>
					</div>
					<div className="mt-9 overflow-hidden border border-border/80 bg-[#111719] shadow-[0_24px_70px_-42px_rgba(23,32,37,0.7)]">
						<Image
							src="/product-library-workbench.png"
							alt="UnoRAG 资料治理台，展示资料空间、文档状态、知识片段与搜索"
							width={1491}
							height={964}
							sizes="(max-width: 1280px) 100vw, 1216px"
							className="h-auto w-full"
						/>
					</div>
				</div>
			</section>

			<section className="border-b border-border/80 bg-[#172025] text-[#edf2f3]">
				<div className="mx-auto grid max-w-7xl lg:grid-cols-[0.85fr_1.15fr]">
					<div className="px-5 py-14 sm:px-8 lg:px-10 lg:py-20">
						<p className="font-mono text-[11px] tracking-[0.16em] text-[#58b9a8] uppercase">
							Private by design
						</p>
						<h2 className="mt-3 text-3xl leading-10 font-semibold">
							部署在客户边界内，
							<br />
							能力仍然可以演进。
						</h2>
						<p className="mt-5 max-w-md text-sm leading-7 text-[#a1afb4]">
							模型、数据库、向量库、对象存储与解析 Provider
							均由部署方配置。Compose 用于单机与试点，Helm 为集群化提供起点。
						</p>
					</div>
					<div className="grid border-t border-[#303c40] sm:grid-cols-2 lg:border-t-0 lg:border-l">
						{[
							[
								ServerCog,
								"Control Plane",
								"Next.js · Session · Workspace · Job",
							],
							[
								Database,
								"Knowledge Plane",
								"Next.js · LangGraph · Qdrant · DBOS",
							],
							[
								LockKeyhole,
								"Security",
								"HMAC · ACL · Active Generation · Audit",
							],
							[Braces, "Integration", "Retrieve / Ask API · Service Keys"],
						].map(([Icon, title, body], index) => {
							const ItemIcon = Icon as typeof FileStack;
							return (
								<div
									key={String(title)}
									className={cn(
										"px-6 py-9",
										index % 2 === 1 && "sm:border-l sm:border-[#303c40]",
										index > 1 && "border-t border-[#303c40]",
										index === 1 && "border-t border-[#303c40] sm:border-t-0",
									)}
								>
									<ItemIcon className="size-5 text-[#58b9a8]" aria-hidden />
									<h3 className="mt-5 font-mono text-sm text-[#edf2f3]">
										{String(title)}
									</h3>
									<p className="mt-2 text-sm leading-6 text-[#a1afb4]">
										{String(body)}
									</p>
								</div>
							);
						})}
					</div>
				</div>
			</section>

			<section className="bg-card">
				<div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-5 py-14 sm:px-8 md:flex-row md:items-center lg:px-10 lg:py-18">
					<div>
						<p className="font-mono text-[11px] tracking-[0.16em] text-cite uppercase">
							Start with evidence
						</p>
						<h2 className="mt-3 text-3xl font-semibold">
							先让一份真实资料开口说话。
						</h2>
						<p className="mt-3 text-sm leading-6 text-muted-foreground">
							创建资料空间、上传文档，然后沿引用回到原文。
						</p>
					</div>
					<Link
						href="/app/libraries"
						className={buttonVariants({ size: "lg" })}
					>
						进入资料治理台
						<ArrowRight data-icon="inline-end" />
					</Link>
				</div>
			</section>
		</main>
	);
}

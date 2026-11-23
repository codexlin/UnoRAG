import {
	Activity,
	ArrowDown,
	ArrowUpRight,
	Check,
	Code2,
	Database,
	FileText,
	GitBranch,
	LockKeyhole,
	Plus,
	Server,
	ShieldCheck,
	Workflow,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { UnoMark, UnoRAGLogo } from "@/components/app/unorag-logo";
import { HeroShowcase } from "@/components/landing/hero-showcase";
import { LandingHeader } from "@/components/landing/landing-header";
import { ProductFilmPlayer } from "@/components/landing/product-film-player";
import { QuickstartSnippet } from "@/components/landing/quickstart-snippet";
import { StripedPattern } from "@/components/landing/striped-pattern";
import { TaglineReveal } from "@/components/landing/tagline-reveal";
import {
	SectionRailNodes,
	UnoWireframe,
} from "@/components/landing/uno-watermark";
import { buttonVariants } from "@/components/ui/button";
import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";
import { cn } from "@/lib/utils";
import "./landing.css";

export async function generateMetadata(): Promise<Metadata> {
	const locale = (await getRequestLanguage()).locale;
	const t = interfaceText(locale);
	const lang = locale === "zh-CN" ? "zh" : "en";
	const title = t(
		"UnoRAG — 开源、自托管的知识库",
		"UnoRAG — Open-source, self-hosted knowledge base",
	);
	const description = t(
		"把内部文档变成可检索、可核对的知识。UnoRAG 将文档治理、证据问答和运行链路放进同一个开源工作台。",
		"Turn internal documents into searchable, verifiable knowledge with document governance, cited answers, and request traces.",
	);
	const ogImage = `/landing-media/hero-${lang}-light.png`;
	return {
		title,
		description,
		openGraph: {
			title,
			description,
			type: "website",
			images: [{ url: ogImage, width: 1440, height: 810, alt: title }],
		},
		twitter: {
			card: "summary_large_image",
			title,
			description,
			images: [ogImage],
		},
	};
}

const heroInvariants = [
	{
		icon: ShieldCheck,
		label: ["检索前核对文档权限", "Access-checked retrieval"],
		detail: [
			"ACL 规则直接进入向量与关键词召回过滤",
			"ACL filters run before vector and keyword recall",
		],
	},
	{
		icon: GitBranch,
		label: ["校验通过后切换版本", "Verified version updates"],
		detail: [
			"后台校验通过才原子切换，旧版本不中断",
			"Atomic cutover only after validation passes",
		],
	},
	{
		icon: Activity,
		label: ["完整请求耗时与用量", "Full trace and usage"],
		detail: [
			"每次问答记录阶段耗时、命中片段与用量",
			"Stage latency, chunks, and token ledger per ask",
		],
	},
] as const;

const documents = [
	{
		icon: FileText,
		title: ["理解资料结构", "Keep document structure"],
		body: [
			"支持 TXT、Markdown、DOCX 与 PDF，保留章节层级、表头与原文定位；复杂排版 PDF 可按策略接入 MinerU 解析。",
			"Preserve sections, table headers, and source locations across TXT, Markdown, DOCX, and PDF documents, with optional MinerU parsing.",
		],
	},
	{
		icon: Workflow,
		title: ["清楚地更新版本", "Publish verified versions"],
		body: [
			"替换与重索引在后台异步完成。新版本校验通过后才切换生效，处理失败时旧版本持续提供服务。",
			"Replace and reindex documents in the background. New versions go live only after validation passes, keeping the previous version active on failure.",
		],
	},
	{
		icon: LockKeyhole,
		title: ["在检索前核对权限", "Check permissions before retrieval"],
		body: [
			"工作区、知识库和文档级 ACL 直接进入向量与关键词召回过滤，成员只获取当前有权访问的片段。",
			"Enforce workspace, library, and document access rules before retrieval so every member only sees authorized excerpts.",
		],
	},
] as const;

const deployment = [
	{
		icon: Server,
		title: ["运行环境", "Runtime"],
		body: [
			"Next.js 应用边界 + DBOS 持久化任务",
			"Next.js edge + DBOS durable worker",
		],
	},
	{
		icon: Database,
		title: ["数据存储", "Storage"],
		body: ["PostgreSQL + Qdrant + Redis", "PostgreSQL + Qdrant + Redis"],
	},
	{
		icon: Code2,
		title: ["模型与解析", "Models and parsing"],
		body: [
			"按部署配置接入云端或本地 Provider",
			"Connect cloud or local model providers",
		],
	},
] as const;

const questions = [
	[
		[
			"需要把文档拿去训练模型吗？",
			"Do I need to train a model on my documents?",
		],
		[
			"不需要。UnoRAG 在回答时先检索当前成员有权访问的文档片段，再作为上下文交给模型生成并附带原文引用。更新资料只需重索引，无需微调模型。",
			"No. UnoRAG retrieves authorized excerpts at question time and passes them as grounded context with source citations. Updating knowledge only requires reindexing.",
		],
	],
	[
		[
			"资料和模型可以完全私有化（如 Ollama / vLLM）吗？",
			"Can models and data stay fully private with Ollama or vLLM?",
		],
		[
			"可以。UnoRAG 支持私有化部署，并可配置任意兼容 OpenAI 协议的本地或内网模型（对话、向量、重排）。是否向外部服务发送数据完全取决于你的 Provider 与解析策略配置。",
			"Yes. Self-host UnoRAG on your own infrastructure and point chat, embedding, and rerank endpoints to OpenAI-compatible local runtimes such as Ollama or vLLM.",
		],
	],
	[
		[
			"检索阶段如何防止越权泄密？",
			"How are workspace and document permissions enforced?",
		],
		[
			"每次检索都在进入向量库与关键词召回之前，由服务端解析组织、工作区、成员角色和文档 ACL 范围并作为强制过滤条件，绝不依赖大模型提示词来「提醒」保密。",
			"Server-resolved organization, workspace, and document ACL scopes are applied as mandatory filters before retrieval runs, never left to prompt instructions.",
		],
	],
	[
		[
			"替换或重新解析文档时，会影响正在进行的问答吗？",
			"Does replacing a document interrupt live answers?",
		],
		[
			"不会。入库与重索引通过 DBOS 工作流在后台构建新 generation，全部校验通过后才原子切换生效；如果解析或向量化失败，旧版本保持在线不受影响。",
			"No. Ingestion and reindexing build a staged generation through DBOS workflows and cut over only after verification passes, leaving the active version online if a job fails.",
		],
	],
	[
		[
			"能通过 API 接入自己的业务应用吗？",
			"Can I integrate UnoRAG into my own application?",
		],
		[
			"可以使用带工作区 Service Key 的 Retrieve 与 Ask API 直接嵌入内部系统，也可以基于 Apache-2.0 源码自由扩展与二次开发。",
			"Use the Retrieve and Ask HTTP APIs with scoped workspace service keys, or build directly on the Apache-2.0 TypeScript codebase.",
		],
	],
	[
		[
			"升级和备份如何保证数据可恢复？",
			"How do upgrades and backups keep data recoverable?",
		],
		[
			"PostgreSQL 保存唯一业务事实源与前向迁移记录，原文保存在对象存储或本地卷；部署文档提供完整的 Compose 升级、回滚和备份检查清单。",
			"PostgreSQL stores the single source of truth with forward-only migrations while original files live in object storage. The deployment guide documents backup and upgrade checks.",
		],
	],
] as const;

const zhTaglineSegments = [
	"每一条回答，",
	"都回到",
	"授权原文。",
	"每一次",
	"文档更新，",
	"都先校验",
	"再上线。",
	"每一份",
	"企业资料，",
	"都留在你的",
	"基础设施里。",
] as const;

const enTaglineSegments = [
	"Every",
	"answer",
	"traces",
	"back",
	"to",
	"its",
	"source.",
	"Every",
	"update",
	"validates",
	"before",
	"going",
	"live.",
	"Every",
	"document",
	"stays",
	"inside",
	"your",
	"infrastructure.",
] as const;

export default async function Home() {
	const locale = (await getRequestLanguage()).locale;
	const t = interfaceText(locale);
	const lang = locale === "zh-CN" ? "zh" : "en";

	return (
		<div className="landing-page bg-background text-foreground">
			<LandingHeader />
			<div className="relative overflow-x-clip">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-y-0 left-[calc(50%-652px)] z-[1] hidden w-7 border-x border-border/80 xl:block"
				>
					<StripedPattern
						width={10}
						height={10}
						className="text-foreground/[0.08] dark:text-foreground/[0.11]"
					/>
				</div>
				<div
					aria-hidden
					className="pointer-events-none absolute inset-y-0 right-[calc(50%-652px)] z-[1] hidden w-7 border-x border-border/80 xl:block"
				>
					<StripedPattern
						width={10}
						height={10}
						className="text-foreground/[0.08] dark:text-foreground/[0.11]"
					/>
				</div>
				<main id="main-content" tabIndex={-1} className="relative z-10">
					<section
						className="landing-hero relative"
						aria-labelledby="hero-title"
					>
						<div
							aria-hidden
							className="landing-hero-spotlight pointer-events-none absolute inset-0"
						/>
						<div
							aria-hidden
							className="landing-hero-stripe-mask pointer-events-none absolute inset-y-0 left-1/2 w-full max-w-[1248px] -translate-x-1/2"
						>
							<StripedPattern
								width={12}
								height={12}
								className="text-foreground/[0.065] dark:text-foreground/[0.085]"
							/>
						</div>

						<div className="landing-wrap landing-hero-copy relative z-10">
							<p className="landing-enter inline-flex items-center gap-2 rounded-full border border-border bg-card/90 px-3.5 py-1 text-xs font-medium text-muted-foreground shadow-2xs">
								<span className="size-1.5 rounded-full bg-cite" aria-hidden />
								{t(
									"Apache-2.0 开源私有化知识工作台",
									"Open source, self-hosted under Apache-2.0",
								)}
							</p>
							<h1 id="hero-title" className="landing-hero-title landing-enter">
								{t(
									"让内部资料，成为可核对的答案。",
									"Turn internal documents into answers you can verify.",
								)}
							</h1>
							<p className="landing-hero-description landing-enter">
								{t(
									"将文档治理、权限过滤检索、原文引用与请求链路放进同一个开源工作台。",
									"Document governance, permission-filtered retrieval, inline citations, and request traces in one workspace.",
								)}
							</p>
							<div className="landing-enter mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
								<Link
									href="/app/ask"
									className={cn(
										buttonVariants({ size: "lg" }),
										"h-11 w-full px-6 text-sm font-medium shadow-xs sm:w-auto",
									)}
								>
									{t("进入工作台", "Open workspace")}
								</Link>
								<a
									href="#deployment"
									className={cn(
										buttonVariants({ variant: "outline", size: "lg" }),
										"h-11 w-full bg-card/85 px-6 text-sm font-medium shadow-2xs sm:w-auto",
									)}
								>
									{t("3 行命令私有部署", "Self-host with Docker")}
								</a>
							</div>
						</div>

						<div className="relative z-10 border-t border-border">
							<SectionRailNodes />
							<div className="mx-auto grid w-full max-w-[1248px] grid-cols-1 divide-y divide-border bg-card/55 md:grid-cols-3 md:divide-x md:divide-y-0 lg:grid-cols-[1fr_1fr_1fr_auto]">
								{heroInvariants.map(({ icon: Icon, label, detail }) => (
									<div
										key={label[1]}
										className="flex items-start gap-3 px-5 py-4 sm:px-6 sm:py-5"
									>
										<Icon
											className="mt-0.5 size-4 shrink-0 text-cite"
											aria-hidden
										/>
										<div className="min-w-0">
											<p className="text-sm font-medium text-foreground">
												{t(label[0], label[1])}
											</p>
											<p className="mt-1 text-xs leading-5 text-muted-foreground">
												{t(detail[0], detail[1])}
											</p>
										</div>
									</div>
								))}
								<a
									href="#walkthrough"
									className="landing-link hidden min-h-11 items-center justify-center gap-1.5 px-5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 lg:inline-flex"
								>
									<ArrowDown className="size-3.5" aria-hidden />
									<span>{t("观看演示", "Walkthrough")}</span>
								</a>
							</div>
						</div>
					</section>

					<div
						aria-hidden
						className="relative h-4 border-t border-border bg-background"
					>
						<div className="relative mx-auto h-full max-w-[1248px]">
							<StripedPattern
								width={10}
								height={10}
								className="text-foreground/[0.08] dark:text-foreground/[0.11]"
							/>
						</div>
					</div>

					<section
						id="walkthrough"
						className="relative scroll-mt-14 border-t border-border py-14 sm:py-20"
						aria-label={t("产品工作流演示", "Product workflow walkthrough")}
					>
						<SectionRailNodes />
						<HeroShowcase />
					</section>

					<section
						id="product"
						className="landing-section border-t border-border"
						aria-labelledby="product-title"
					>
						<SectionRailNodes />
						<div className="landing-wrap">
							<div className="landing-section-heading">
								<div>
									<h2 id="product-title">
										{t(
											"资料持续更新，版本始终清楚。",
											"Keep documents up to date without losing track of versions.",
										)}
									</h2>
								</div>
								<p>
									{t(
										"上传只是开始。把原文、后台处理任务、生效版本与成员可见范围放在同一个台账里，一眼看清哪些可用、哪里需要处理。",
										"See original files, processing jobs, active versions, and access visibility together in one governed ledger.",
									)}
								</p>
							</div>
							<ProductFilmPlayer
								light={{
									videoSrc: `/landing-media/library-${lang}-light.mp4`,
									posterSrc: `/landing-media/library-${lang}-light.png`,
								}}
								dark={{
									videoSrc: `/landing-media/library-${lang}-dark.mp4`,
									posterSrc: `/landing-media/library-${lang}-dark.png`,
								}}
								alt={t(
									"UnoRAG 知识库工作台动态演示：展示文档台账、后台解析校验与版本安全切换",
									"UnoRAG library workbench demo showing document ledger, background validation, and safe version cutover",
								)}
								caption={t(
									"示例工作区数据：演示文档解析校验与版本无缝切换，不代表实际耗时承诺。",
									"Sample workspace data demonstrating document validation and safe version cutover.",
								)}
								aspectClassName="aspect-[1440/860]"
								className="ring-4 ring-muted/70 sm:ring-[6px]"
							/>
							<dl className="mt-10 grid gap-5 md:grid-cols-3 md:gap-6">
								{documents.map(({ icon: Icon, title, body }) => (
									<div
										key={title[1]}
										className="min-w-0 rounded-xl border border-border/80 bg-card/70 p-5 shadow-2xs sm:p-6"
									>
										<div className="mb-4 inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-primary shadow-2xs">
											<Icon className="size-4 shrink-0" aria-hidden />
										</div>
										<dt className="text-base font-medium text-foreground">
											{t(title[0], title[1])}
										</dt>
										<dd className="mt-2.5 text-sm leading-7 text-muted-foreground [text-wrap:pretty]">
											{t(body[0], body[1])}
										</dd>
									</div>
								))}
							</dl>
						</div>
					</section>

					<section
						aria-label={t("核心原则", "Core principles")}
						className="relative border-t border-border bg-muted/25 py-20 sm:py-28"
					>
						<SectionRailNodes />
						<div className="landing-wrap relative z-10 flex flex-col items-center gap-6">
							<div
								aria-hidden
								className="inline-flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-2xs"
							>
								<UnoMark className="size-5" decorative />
							</div>
							<TaglineReveal
								segments={
									locale === "zh-CN" ? zhTaglineSegments : enTaglineSegments
								}
								isCjk={locale === "zh-CN"}
							/>
						</div>
					</section>

					<section
						id="observability"
						className="landing-section border-t border-border"
						aria-labelledby="observability-title"
					>
						<SectionRailNodes />
						<div className="landing-wrap landing-observability-grid">
							<div className="min-w-0">
								<h2 id="observability-title">
									{t(
										"回答之外，也看得见过程。",
										"See how the system arrived at every answer.",
									)}
								</h2>
								<p className="mt-6 max-w-md text-base leading-7 text-muted-foreground [text-wrap:pretty]">
									{t(
										"慢在哪里、为什么拒答、模型消耗了多少 Token。沿同一条请求记录，完整核对检索、证据判断与生成过程。",
										"Pinpoint delays, audit refusals, and inspect model token usage across retrieval, evidence verification, and generation.",
									)}
								</p>
								<ul className="mt-8 space-y-4 text-sm">
									{[
										t(
											"请求与入库任务的逐阶段耗时",
											"Stage timings for Ask requests and ingestion jobs",
										),
										t(
											"错误分类、重试记录与告警投递状态",
											"Error categories, retries, and alert delivery status",
										),
										t(
											"逐次 LLM 用量与可选 OTel / Langfuse 接入",
											"Per-call LLM usage with optional OTel and Langfuse export",
										),
									].map((item) => (
										<li key={item} className="flex items-start gap-3">
											<span
												aria-hidden
												className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-cite/30 bg-cite/10 text-cite"
											>
												<Check className="size-3" />
											</span>
											<span className="leading-6">{item}</span>
										</li>
									))}
								</ul>
								<p className="mt-8 max-w-md text-xs leading-6 text-muted-foreground [text-wrap:pretty]">
									{t(
										"未上报的数据明确留空。Token 不等于费用，阶段累计耗时也不冒充精确并行时间轴。",
										"Unreported data stays blank. Tokens are not billing costs, and summed stage timings do not pretend to be a parallel timeline.",
									)}
								</p>
							</div>
							<ProductFilmPlayer
								light={{
									videoSrc: `/landing-media/trace-${lang}-light.mp4`,
									posterSrc: `/landing-media/trace-${lang}-light.png`,
								}}
								dark={{
									videoSrc: `/landing-media/trace-${lang}-dark.mp4`,
									posterSrc: `/landing-media/trace-${lang}-dark.png`,
								}}
								alt={t(
									"UnoRAG 请求链路动态演示：按阶段展开检索、证据判断与生成耗时，并展示逐次模型 Token 用量",
									"UnoRAG request trace demo showing sequential stage timings and per-call model token usage",
								)}
								caption={t(
									"示例诊断数据：展示阶段耗时与逐次模型用量结构。",
									"Sample diagnostic trace illustrating stage timing and model usage breakdown.",
								)}
								aspectClassName="aspect-[1080/900]"
								className="landing-trace-image ring-4 ring-muted/70 sm:ring-[6px]"
							/>
						</div>
					</section>

					<section
						id="deployment"
						className="landing-section border-t border-border bg-muted/25"
						aria-labelledby="deployment-title"
					>
						<SectionRailNodes />
						<div className="landing-wrap">
							<div className="landing-section-heading">
								<div>
									<h2 id="deployment-title">
										{t(
											"你的部署，你的数据与模型。",
											"Your deployment. Your data and models.",
										)}
									</h2>
								</div>
								<p>
									{t(
										"一套实例服务一个团队。用 Docker Compose 快速启动，再按实际资料与内网环境验证质量、容量与恢复方案。",
										"Run one dedicated instance for your team. Start with Docker Compose, then validate quality, capacity, and recovery on your own environment.",
									)}
								</p>
							</div>
							<div className="grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
								<dl className="divide-y divide-border rounded-xl border border-border bg-card px-5 shadow-2xs">
									{deployment.map(({ icon: Icon, title, body }) => (
										<div
											key={title[1]}
											className="flex items-center justify-between gap-4 py-4"
										>
											<dt className="flex shrink-0 items-center gap-3 text-sm font-medium text-foreground">
												<span
													aria-hidden
													className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground"
												>
													<Icon className="size-4" />
												</span>
												{t(title[0], title[1])}
											</dt>
											<dd className="text-right text-sm text-muted-foreground">
												{t(body[0], body[1])}
											</dd>
										</div>
									))}
								</dl>
								<div className="min-w-0">
									<QuickstartSnippet />
									<a
										href="https://github.com/codexlin/UnoRAG/blob/main/docs/DEPLOYMENT.md"
										target="_blank"
										rel="noreferrer"
										className="landing-link mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground"
									>
										{t("查看完整部署文档", "Read the deployment guide")}
										<ArrowUpRight className="size-4" aria-hidden />
									</a>
								</div>
							</div>
							<div className="mt-16 border-t border-border pt-10">
								<h3 className="mb-4 text-xl font-semibold tracking-[-0.015em]">
									{t("开始之前", "Before you start")}
								</h3>
								<div className="divide-y divide-border">
									{questions.map(([question, answer]) => (
										<details key={question[1]} className="group py-4">
											<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring">
												<span>{t(question[0], question[1])}</span>
												<Plus
													className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-open:rotate-45 motion-reduce:transition-none"
													aria-hidden
												/>
											</summary>
											<p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground [text-wrap:pretty]">
												{t(answer[0], answer[1])}
											</p>
										</details>
									))}
								</div>
							</div>
						</div>
					</section>
				</main>
				<footer className="relative z-10 border-t border-border bg-background py-12 sm:py-16">
					<SectionRailNodes />
					<div className="landing-wrap">
						<div className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-10">
							<UnoWireframe
								accentRing
								className="absolute -right-8 -bottom-12 size-[260px] rotate-12 text-foreground/[0.09] dark:text-foreground/[0.14]"
							/>
							<div className="relative z-10 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
								<div>
									<UnoRAGLogo size="sm" withWordmark />
									<p className="mt-3 text-sm text-muted-foreground [text-wrap:pretty]">
										{t(
											"从第一份内部文档开始，建立可核对的知识库。",
											"Build a verifiable knowledge base starting with your first internal document.",
										)}
									</p>
								</div>
								<Link
									href="/app/ask"
									className={cn(
										buttonVariants({ size: "lg" }),
										"h-11 w-full px-6 text-sm font-medium shadow-xs sm:w-auto",
									)}
								>
									{t("进入工作台", "Open workspace")}
								</Link>
							</div>
						</div>
						<div className="mt-8 flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
							<a
								href="https://unobyte.dev"
								target="_blank"
								rel="noreferrer"
								className="landing-link inline-flex min-h-11 items-center"
							>
								{t("由 Unobyte 构建", "Built by Unobyte")}
							</a>
							<div className="flex flex-wrap gap-6">
								<a
									href="https://github.com/codexlin/UnoRAG/blob/main/docs/DEPLOYMENT.md"
									target="_blank"
									rel="noreferrer"
									className="landing-link inline-flex min-h-11 items-center"
								>
									{t("部署文档", "Docs")}
								</a>
								<a
									href="https://github.com/codexlin/UnoRAG"
									target="_blank"
									rel="noreferrer"
									className="landing-link inline-flex min-h-11 items-center"
								>
									GitHub
								</a>
								<a
									href="https://github.com/codexlin/UnoRAG/blob/main/LICENSE"
									target="_blank"
									rel="noreferrer"
									className="landing-link inline-flex min-h-11 items-center"
								>
									Apache-2.0
								</a>
							</div>
						</div>
					</div>
				</footer>
			</div>
		</div>
	);
}

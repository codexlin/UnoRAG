import {
	ArrowRight,
	ArrowUpRight,
	Check,
	Code2,
	Database,
	FileText,
	LockKeyhole,
	Plus,
	Server,
	Workflow,
} from "lucide-react";
import type { Metadata } from "next";
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { EvidenceExplorer } from "@/components/landing/evidence-explorer";
import { LandingHeader } from "@/components/landing/landing-header";
import { buttonVariants } from "@/components/ui/button";
import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";
import { cn } from "@/lib/utils";
import libraryLight from "../../public/product-library-workbench.png";
import libraryDark from "../../public/product-library-workbench-dark.png";
import traceLight from "../../public/product-request-trace.png";
import traceDark from "../../public/product-request-trace-dark.png";
import "./landing.css";

export async function generateMetadata(): Promise<Metadata> {
	const t = interfaceText((await getRequestLanguage()).locale);
	const title = t(
		"UnoRAG · 开源、自托管的知识库",
		"UnoRAG · Open-source, self-hosted knowledge base",
	);
	return {
		title,
		description: t(
			"把内部文档变成可检索、可核对的知识。UnoRAG 将文档治理、证据问答和运行链路放进同一个开源工作台。",
			"Turn internal documents into searchable, verifiable knowledge with document governance, cited answers, and request traces.",
		),
		openGraph: {
			title,
			description: t(
				"从文档到答案，每一步都有依据。",
				"From source document to evidence-backed answer.",
			),
			type: "website",
		},
	};
}

const documents = [
	{
		icon: FileText,
		title: ["理解资料结构", "Keep document structure"],
		body: [
			"TXT、Markdown、DOCX 与 PDF。保留章节、表头和来源定位，复杂 PDF 可按策略接入 MinerU。",
			"Preserve sections, headers, and source locations in TXT, Markdown, DOCX, and PDF. Optionally use MinerU for complex PDFs.",
		],
	},
	{
		icon: Workflow,
		title: ["清楚地更新版本", "Publish verified versions"],
		body: [
			"替换和重索引在后台执行。新版校验通过才切换，处理失败时保留旧版服务。",
			"Replace and reindex in the background. A new version goes live only after validation; failures leave the previous version available.",
		],
	},
	{
		icon: LockKeyhole,
		title: ["在检索前核对权限", "Check permissions before retrieval"],
		body: [
			"工作区、知识库和文档权限进入召回过滤。成员只获取当前有权访问的资料。",
			"Filter by workspace, library, and document permissions before retrieving evidence.",
		],
	},
] as const;
const deployment = [
	{
		icon: Server,
		title: ["运行环境", "Runtime"],
		body: ["Next.js + DBOS Worker", "Next.js + DBOS Worker"],
	},
	{
		icon: Database,
		title: ["数据存储", "Storage"],
		body: ["PostgreSQL + Qdrant + Redis", "PostgreSQL + Qdrant + Redis"],
	},
	{
		icon: Code2,
		title: ["模型与解析", "Models and parsing"],
		body: ["按部署配置接入 Provider", "Configure your own providers"],
	},
] as const;
const questions = [
	[
		[
			"需要把文档拿去训练模型吗？",
			"Do I need to train a model on my documents?",
		],
		[
			"不需要。RAG 在回答时检索有权访问的文档片段，再提供给模型作为上下文。更新资料不等于重新训练模型。",
			"No. RAG retrieves authorized excerpts and gives them to the model as context at answer time. Updating documents does not retrain the model.",
		],
	],
	[
		["资料和模型可以自己管理吗？", "Can I manage my own data and models?"],
		[
			"可以自行部署，并配置自己的模型、数据库、向量库和文件存储。外部模型或解析服务是否接收资料，取决于你的 Provider 配置与解析策略。",
			"Yes. Self-host UnoRAG and configure your models, databases, vector store, and file storage. Data sent to external services depends on your provider and parsing settings.",
		],
	],
	[
		["能接入自己的应用吗？", "Can I integrate it into my app?"],
		[
			"可以使用带 Service Key 的 Retrieve / Ask API，也可以直接基于 Apache-2.0 源码二次开发。公共文档生命周期 API 仍有边界，接入前应阅读接口文档。",
			"Use the Retrieve or Ask API with a service key, or extend the Apache-2.0 source. Check the API docs for supported document lifecycle operations.",
		],
	],
] as const;

async function ProductImage({
	darkSrc,
	src,
	alt,
	className,
}: {
	darkSrc: StaticImageData;
	src: StaticImageData;
	alt: string;
	className?: string;
}) {
	const t = interfaceText((await getRequestLanguage()).locale);
	return (
		<div className={cn("min-w-0", className)}>
			<a
				href={src.src}
				target="_blank"
				rel="noreferrer"
				title={t("查看原尺寸图片", "View full-size image")}
				aria-label={t(`${alt}，查看原图`, `${alt}, view full size`)}
				className="block cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring dark:hidden"
			>
				<Image
					src={src}
					alt={alt}
					sizes="(max-width: 768px) 100vw, 1280px"
					className="h-auto w-full"
				/>
			</a>
			<a
				href={darkSrc.src}
				target="_blank"
				rel="noreferrer"
				title={t("查看原尺寸图片", "View full-size image")}
				aria-label={t(`${alt}，查看原图`, `${alt}, view full size`)}
				className="hidden cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring dark:block"
			>
				<Image
					src={darkSrc}
					alt={alt}
					sizes="(max-width: 768px) 100vw, 1280px"
					className="h-auto w-full"
				/>
			</a>
		</div>
	);
}

export default async function Home() {
	const t = interfaceText((await getRequestLanguage()).locale);
	return (
		<div className="landing-page bg-background text-foreground">
			<LandingHeader />
			<main id="main-content" tabIndex={-1}>
				<section className="landing-hero" aria-labelledby="hero-title">
					<div className="landing-wrap landing-hero-copy">
						<p className="landing-enter text-sm text-muted-foreground">
							{t(
								"开源 · 私有化部署 · Apache-2.0",
								"Open source · Self-hosted · Apache-2.0",
							)}
						</p>
						<h1
							id="hero-title"
							className="landing-hero-title landing-enter"
							translate="no"
						>
							UnoRAG
						</h1>
						<p className="landing-hero-lead landing-enter">
							{t(
								"让内部资料，成为可核对的答案。",
								"Turn internal documents into answers you can verify.",
							)}
						</p>
						<p className="landing-hero-description landing-enter">
							{t(
								"文档治理、证据问答、运行链路。",
								"Document governance, cited answers, and request traces.",
							)}
							<br className="sm:hidden" />
							{t(
								"在同一个开源工作台里，管理你的知识。",
								"Manage your knowledge in one open-source workspace.",
							)}
						</p>
						<div className="landing-enter mt-7 flex flex-wrap justify-center gap-3">
							<Link
								href="/app/ask"
								className={cn(
									buttonVariants({ size: "lg" }),
									"min-h-11 gap-2 px-6",
								)}
							>
								{t("进入工作台", "Open workspace")}
								<ArrowRight className="size-4" aria-hidden />
							</Link>
							<a
								href="https://github.com/codexlin/UnoRAG"
								target="_blank"
								rel="noreferrer"
								className={cn(
									buttonVariants({ variant: "outline", size: "lg" }),
									"min-h-11 gap-2 px-6",
								)}
							>
								{t("查看源码", "View source")}
								<ArrowUpRight className="size-4" aria-hidden />
							</a>
						</div>
					</div>
					<EvidenceExplorer />
				</section>

				<section
					id="product"
					className="landing-section border-t border-border"
					aria-labelledby="product-title"
				>
					<div className="landing-wrap">
						<div className="landing-section-heading">
							<div>
								<p className="landing-kicker">
									{t("01 / 知识库", "01 / Libraries")}
								</p>
								<h2 id="product-title">
									{t("资料持续更新，", "Keep documents up to date")}
									<br />
									{t("版本始终清楚。", "without losing track of versions.")}
								</h2>
							</div>
							<p>
								{t(
									"上传只是开始。把原文、处理任务、生效版本和可见范围放在一起，知道什么能用，也知道哪里需要处理。",
									"See original files, processing jobs, active versions, and visibility in one place.",
								)}
							</p>
						</div>
						<ProductImage
							src={libraryLight}
							darkSrc={libraryDark}
							alt={t(
								"UnoRAG 知识库：可搜索的独立库列表、文档状态和处理操作，使用示例资料",
								"UnoRAG library with a searchable list, document statuses, and actions using sample data",
							)}
							className="overflow-hidden border border-border"
						/>
						<dl className="mt-8 grid gap-7 md:grid-cols-3 md:gap-10">
							{documents.map(({ icon: Icon, title, body }) => (
								<div key={title[1]} className="min-w-0">
									<dt className="flex items-center gap-2 text-base font-medium">
										<Icon
											className="size-4 text-muted-foreground"
											aria-hidden
										/>
										{t(title[0], title[1])}
									</dt>
									<dd className="mt-3 text-sm leading-7 text-muted-foreground">
										{t(body[0], body[1])}
									</dd>
								</div>
							))}
						</dl>
					</div>
				</section>

				<section
					id="observability"
					className="landing-section border-t border-border bg-muted/35"
					aria-labelledby="observability-title"
				>
					<div className="landing-wrap landing-observability-grid">
						<div className="min-w-0">
							<p className="landing-kicker">
								{t("02 / 可观测", "02 / Observability")}
							</p>
							<h2 id="observability-title">
								{t("回答之外，", "See how the system")}
								<br />
								{t("也看得见过程。", "arrived at an answer.")}
							</h2>
							<p className="mt-6 max-w-md text-base leading-8 text-muted-foreground">
								{t(
									"慢在哪里，为什么拒答，模型用了多少 Token。沿同一条请求记录，核对检索、证据判断与生成过程。",
									"Find delays, review refusals, and see model token usage. Follow one request through retrieval, evidence checks, and generation.",
								)}
							</p>
							<ul className="mt-8 space-y-4 text-sm">
								{[
									t(
										"请求与入库任务的阶段耗时",
										"Stage timings for requests and ingestion jobs",
									),
									t(
										"错误分类、重试与告警记录",
										"Error categories, retries, and alerts",
									),
									t(
										"LLM 用量和可选 OTel / Langfuse 接入",
										"LLM usage and optional OTel / Langfuse integration",
									),
								].map((item) => (
									<li key={item} className="flex gap-3">
										<Check
											className="mt-0.5 size-4 shrink-0 text-cite"
											aria-hidden
										/>
										{item}
									</li>
								))}
							</ul>
							<p className="mt-8 max-w-md text-xs leading-6 text-muted-foreground">
								{t(
									"未上报的数据明确留空。Token 不等于费用，阶段累计耗时也不冒充精确并行时间轴。",
									"Unreported data stays blank. Tokens aren't costs, and the sum of stage timings isn't a parallel timeline.",
								)}
							</p>
						</div>
						<ProductImage
							src={traceLight}
							darkSrc={traceDark}
							alt={t(
								"UnoRAG 请求链路详情：阶段瀑布和逐次模型 Token 用量，使用示例诊断数据",
								"UnoRAG request trace showing stage timings and per-call token usage with sample data",
							)}
							className="landing-trace-image overflow-hidden border border-border bg-background"
						/>
					</div>
				</section>

				<section
					id="deployment"
					className="landing-section border-t border-border"
					aria-labelledby="deployment-title"
				>
					<div className="landing-wrap">
						<div className="landing-section-heading">
							<div>
								<p className="landing-kicker">
									{t("03 / 私有部署", "03 / Self-hosting")}
								</p>
								<h2 id="deployment-title">
									{t("你的部署，", "Your deployment.")}
									<br />
									{t("你的数据与模型。", "Your data and models.")}
								</h2>
							</div>
							<p>
								{t(
									"一套实例服务一个团队。先用 Docker Compose 开始，再按实际资料和运行环境验证质量、容量与恢复方案。",
									"Run one instance for your team. Start with Docker Compose, then validate quality, capacity, and recovery with your own data and environment.",
								)}
							</p>
						</div>
						<div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
							<dl className="divide-y divide-border">
								{deployment.map(({ icon: Icon, title, body }) => (
									<div
										key={title[1]}
										className="flex items-center justify-between gap-4 py-5 first:pt-0"
									>
										<dt className="flex shrink-0 items-center gap-2 text-sm">
											<Icon
												className="size-4 text-muted-foreground"
												aria-hidden
											/>
											{t(title[0], title[1])}
										</dt>
										<dd className="text-right text-sm text-muted-foreground">
											{t(body[0], body[1])}
										</dd>
									</div>
								))}
							</dl>
							<div className="min-w-0">
								<div className="border border-border bg-muted/50 p-5 sm:p-6">
									<p className="mb-4 text-xs text-muted-foreground">
										{t("已安装 Docker / Compose", "Docker / Compose installed")}
									</p>
									<pre
										// biome-ignore lint/a11y/noNoninteractiveTabindex: the overflowing code block needs keyboard scrolling
										tabIndex={0}
										className="overflow-x-auto font-mono text-xs leading-7 focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
									>
										<code>
											{
												"git clone https://github.com/codexlin/UnoRAG.git\ncd UnoRAG\n./start.sh"
											}
										</code>
									</pre>
								</div>
								<a
									href="https://github.com/codexlin/UnoRAG/blob/main/docs/DEPLOYMENT.md"
									target="_blank"
									rel="noreferrer"
									className="landing-link mt-3 inline-flex min-h-11 items-center gap-2 text-sm"
								>
									{t("查看部署文档", "Deployment guide")}
									<ArrowUpRight className="size-4" aria-hidden />
								</a>
							</div>
						</div>
						<div className="mt-16 border-t border-border pt-8">
							<h3 className="mb-4 text-lg font-medium">
								{t("开始之前", "Before you start")}
							</h3>
							<div className="divide-y divide-border">
								{questions.map(([question, answer]) => (
									<details key={question[1]} className="group py-5">
										<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
											{t(question[0], question[1])}
											<Plus
												className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-45 motion-reduce:transition-none"
												aria-hidden
											/>
										</summary>
										<p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
											{t(answer[0], answer[1])}
										</p>
									</details>
								))}
							</div>
						</div>
					</div>
				</section>
			</main>
			<footer className="border-t border-border bg-muted/35 py-12 sm:py-16">
				<div className="landing-wrap">
					<div className="flex flex-col items-start justify-between gap-7 sm:flex-row sm:items-center">
						<div>
							<UnoRAGLogo size="md" withWordmark />
							<p className="mt-4 text-sm text-muted-foreground">
								{t(
									"从一份资料，开始建立可核对的知识库。",
									"Build a verifiable knowledge base, one document at a time.",
								)}
							</p>
						</div>
						<Link
							href="/app/ask"
							className={cn(buttonVariants({ size: "lg" }), "min-h-11 px-6")}
						>
							{t("进入工作台", "Open workspace")}
							<ArrowRight className="size-4" aria-hidden />
						</Link>
					</div>
					<div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-xs text-muted-foreground">
						<a
							href="https://unobyte.dev"
							target="_blank"
							rel="noreferrer"
							className="landing-link inline-flex min-h-11 items-center"
						>
							{t("由 Unobyte 构建", "Built by Unobyte")}
						</a>
						<div className="flex flex-wrap gap-5">
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
	);
}

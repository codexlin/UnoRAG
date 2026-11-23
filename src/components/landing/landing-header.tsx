"use client";

import { ArrowUpRight, Menu } from "lucide-react";
import Link from "next/link";
import { AnimatedThemeToggler } from "@/components/app/animated-theme-toggler";
import { LanguageMenu } from "@/components/app/language-menu";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { StripedPattern } from "@/components/landing/striped-pattern";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const links = [
	["知识库", "Libraries", "#product"],
	["可观测", "Observability", "#observability"],
	["私有部署", "Self-hosting", "#deployment"],
] as const;

function GitHubIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 24 24"
			fill="currentColor"
			className={className}
		>
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14 0 1.54-.01 2.79-.01 3.17 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

function HeaderRailNodes() {
	const node =
		"pointer-events-none absolute bottom-0 z-20 hidden size-3.5 translate-y-1/2 text-muted-foreground/55 xl:block";
	return (
		<>
			<svg
				aria-hidden
				viewBox="0 0 14 14"
				className={`${node} left-[calc(50%-624px)] -translate-x-1/2`}
			>
				<path d="M7 0v14M0 7h14" stroke="currentColor" strokeWidth="1" />
			</svg>
			<svg
				aria-hidden
				viewBox="0 0 14 14"
				className={`${node} right-[calc(50%-624px)] translate-x-1/2`}
			>
				<path d="M7 0v14M0 7h14" stroke="currentColor" strokeWidth="1" />
			</svg>
		</>
	);
}

export function LandingHeader() {
	const t = useInterfaceText();
	return (
		<header className="sticky top-0 z-30 border-b border-border/80 bg-background/90 backdrop-blur-md">
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

				<div className="relative z-10 mx-auto flex h-14 w-full max-w-[1248px] items-center justify-between gap-3 px-4 sm:px-6 md:grid md:grid-cols-[1fr_auto_1fr]">
					<a href="#main-content" className="landing-skip">
						{t("跳至主要内容", "Skip to main content")}
					</a>
					<Link
						href="/"
						aria-label={t("UnoRAG 首页", "UnoRAG home")}
						className="inline-flex min-h-11 shrink-0 items-center justify-self-start rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
					>
						<UnoRAGLogo size="sm" withWordmark />
					</Link>
					<nav
						aria-label={t("主导航", "Main navigation")}
						className="hidden items-center justify-self-center gap-1 text-sm text-muted-foreground md:flex"
					>
						{links.map(([zh, en, href]) => (
							<a
								key={href}
								href={href}
								className="landing-link inline-flex h-8 items-center rounded-md px-3 whitespace-nowrap transition-colors hover:bg-muted/70 hover:text-foreground"
							>
								{t(zh, en)}
							</a>
						))}
					</nav>
					<div className="flex items-center justify-self-end gap-0.5 sm:gap-1">
						<a
							href="https://github.com/codexlin/UnoRAG"
							target="_blank"
							rel="noreferrer"
							aria-label="GitHub"
							title="GitHub"
							className="landing-link hidden size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground sm:inline-flex"
						>
							<GitHubIcon className="size-4" />
						</a>
						<LanguageMenu />
						<AnimatedThemeToggler />
						<ThemeToggle />
						<span
							aria-hidden
							className="mx-1.5 hidden h-4 w-px bg-border sm:inline-block"
						/>
						<Link
							href="/app/ask"
							className={cn(
								buttonVariants({ size: "sm" }),
								"hidden h-8 min-w-[7.75rem] justify-center px-3.5 text-xs font-medium shadow-2xs sm:inline-flex",
							)}
						>
							{t("进入工作台", "Open workspace")}
						</Link>
						<Sheet>
							<SheetTrigger
								render={
									<Button
										variant="ghost"
										size="icon"
										className="size-11 md:hidden"
										aria-label={t("打开导航", "Open navigation")}
									/>
								}
							>
								<Menu aria-hidden />
							</SheetTrigger>
							<SheetContent
								className="w-full max-w-sm!"
								aria-describedby={undefined}
							>
								<SheetHeader className="border-b p-5">
									<SheetTitle>UnoRAG</SheetTitle>
								</SheetHeader>
								<nav
									aria-label={t("手机导航", "Mobile navigation")}
									className="flex flex-col p-5"
								>
									{links.map(([zh, en, href]) => (
										<SheetClose
											key={href}
											render={
												<a
													href={href}
													className="landing-link flex min-h-14 items-center border-b border-border text-base font-medium"
												/>
											}
										>
											{t(zh, en)}
										</SheetClose>
									))}
									<SheetClose
										render={
											<a
												href="https://github.com/codexlin/UnoRAG"
												target="_blank"
												rel="noreferrer"
												className="landing-link flex min-h-14 items-center justify-between border-b border-border text-base font-medium"
											/>
										}
									>
										GitHub
										<ArrowUpRight
											className="size-4 text-muted-foreground"
											aria-hidden
										/>
									</SheetClose>
									<SheetClose
										render={
											<Link
												href="/app/ask"
												className={cn(buttonVariants(), "mt-6 min-h-11 w-full")}
											/>
										}
									>
										{t("进入工作台", "Open workspace")}
									</SheetClose>
								</nav>
							</SheetContent>
						</Sheet>
					</div>
				</div>
			</div>
			<HeaderRailNodes />
		</header>
	);
}

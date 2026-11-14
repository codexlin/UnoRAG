"use client";

import { ArrowUpRight, Menu } from "lucide-react";
import Link from "next/link";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const links = [
	["产品", "#product"],
	["可观测", "#observability"],
	["私有部署", "#deployment"],
] as const;

export function LandingHeader() {
	return (
		<header className="border-b border-border bg-background">
			<div className="landing-wrap flex h-16 items-center justify-between gap-3 sm:h-18">
				<a href="#main-content" className="landing-skip">
					跳至主要内容
				</a>
				<Link
					href="/"
					aria-label="UnoRAG 首页"
					className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
				>
					<UnoRAGLogo size="md" withWordmark />
				</Link>
				<nav
					aria-label="主导航"
					className="hidden items-center gap-8 text-sm text-muted-foreground md:flex"
				>
					{links.map(([label, href]) => (
						<a
							key={href}
							href={href}
							className="landing-link inline-flex min-h-11 items-center"
						>
							{label}
						</a>
					))}
					<a
						href="https://github.com/codexlin/UnoRAG"
						target="_blank"
						rel="noreferrer"
						className="landing-link inline-flex min-h-11 items-center gap-1.5"
					>
						GitHub
						<ArrowUpRight className="size-3.5" aria-hidden />
					</a>
				</nav>
				<div className="flex items-center gap-1.5 sm:gap-3">
					<ThemeToggle />
					<Link
						href="/app/ask"
						className={cn(
							buttonVariants(),
							"hidden min-h-11 px-4 sm:inline-flex",
						)}
					>
						进入工作台
					</Link>
					<Sheet>
						<SheetTrigger
							render={
								<Button
									variant="ghost"
									size="icon"
									className="size-11 md:hidden"
									aria-label="打开导航"
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
							<nav aria-label="手机导航" className="flex flex-col p-5">
								{links.map(([label, href]) => (
									<SheetClose
										key={href}
										render={
											<a
												href={href}
												className="landing-link flex min-h-14 items-center border-b border-border text-lg"
											/>
										}
									>
										{label}
									</SheetClose>
								))}
								<SheetClose
									render={
										<Link
											href="/app/ask"
											className={cn(buttonVariants(), "mt-6 min-h-11")}
										/>
									}
								>
									进入工作台
								</SheetClose>
							</nav>
						</SheetContent>
					</Sheet>
				</div>
			</div>
		</header>
	);
}

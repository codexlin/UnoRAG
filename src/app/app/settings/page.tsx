"use client";

import {
	Activity,
	ArrowUpRight,
	KeyRound,
	Mail,
	MessagesSquare,
	ScrollText,
	Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	GuardedLink,
	useNavigationGuard,
} from "@/components/app/navigation-guard";
import { useSession } from "@/components/app/session-provider";
import type { SettingsPanelState } from "@/components/app/settings/use-settings-panel-state";
import { WorkspaceServicePanel } from "@/components/app/settings/workspace-service-panel";
import { WorkspaceAskSettingsPanel } from "@/components/app/workspace-ask-settings-panel";
import { WorkspaceIntegrationKeysPanel } from "@/components/app/workspace-integration-keys-panel";
import { WorkspaceMembersPanel } from "@/components/app/workspace-members-panel";
import { WorkspaceNotificationsPanel } from "@/components/app/workspace-notifications-panel";
import { buttonVariants } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const SECTIONS = [
	{ id: "ask-settings", label: "问答策略", icon: MessagesSquare },
	{ id: "members", label: "成员与邀请", icon: Users },
	{ id: "integrations", label: "集成密钥", icon: KeyRound },
	{ id: "notifications", label: "邮件通知", icon: Mail, adminOnly: true },
	{ id: "service", label: "服务状态", icon: Activity },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
	const { identity, can } = useSession();
	const canManage = can("manageMembers");
	const sections = SECTIONS.filter(
		(section) => !("adminOnly" in section) || canManage,
	);
	const sectionOptions = sections.map(({ id, label }) => ({
		value: id,
		label,
	}));
	const [active, setActive] = useState<SectionId | null>(null);
	const activeRef = useRef(active);
	const [panelState, setPanelState] = useState<SettingsPanelState>({
		dirty: false,
		busy: false,
	});
	const { setGuard, allowNavigation } = useNavigationGuard();
	const reportState = useCallback(
		(state: SettingsPanelState) => {
			setPanelState(state);
			setGuard(state);
		},
		[setGuard],
	);

	const commitSection = useCallback((next: SectionId) => {
		activeRef.current = next;
		setActive(next);
		const url = `${window.location.pathname}${window.location.search}#${next}`;
		window.history.replaceState(null, "", url);
	}, []);

	useEffect(() => {
		function fromHash(): SectionId | undefined {
			const value = window.location.hash.slice(1);
			return SECTIONS.find(
				(section) =>
					section.id === value && (!("adminOnly" in section) || canManage),
			)?.id;
		}
		activeRef.current = fromHash() ?? "ask-settings";
		setActive(activeRef.current);
		function handleHistory() {
			const next = fromHash();
			if (!next || next === activeRef.current) return;
			// History traversal is not cancelable; never overwrite its destination.
			activeRef.current = next;
			setActive(next);
		}
		window.addEventListener("hashchange", handleHistory);
		window.addEventListener("popstate", handleHistory);
		return () => {
			window.removeEventListener("hashchange", handleHistory);
			window.removeEventListener("popstate", handleHistory);
			setGuard({ dirty: false, busy: false });
		};
	}, [canManage, setGuard]);

	function selectSection(next: SectionId) {
		if (next === active) return;
		if (allowNavigation(() => commitSection(next))) commitSection(next);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
			<div className="mx-auto w-full max-w-6xl">
				<header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border pb-6">
					<h2 className="text-2xl font-medium">工作区设置</h2>
					<p className="min-w-0 break-words text-sm text-muted-foreground">
						{identity.workspaceName}
					</p>
				</header>
				<div className="grid min-w-0 gap-8 pt-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-10">
					<div className="min-w-0 lg:hidden">
						<label htmlFor="settings-section" className="sr-only">
							设置分区
						</label>
						<Select
							items={sectionOptions}
							value={active}
							disabled={!active || panelState.busy}
							onValueChange={(value) => {
								if (value !== null) selectSection(value);
							}}
						>
							<SelectTrigger
								id="settings-section"
								aria-label="设置分区"
								className="min-h-11 w-full min-w-0"
							>
								<SelectValue placeholder="加载设置…" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{sectionOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
					<nav
						aria-label="设置分区"
						className="hidden min-w-0 self-start lg:sticky lg:top-6 lg:block"
					>
						<ul className="space-y-1">
							{sections.map(({ id, label, icon: Icon }) => (
								<li key={id}>
									<a
										href={`#${id}`}
										aria-current={active === id ? "page" : undefined}
										aria-disabled={panelState.busy || undefined}
										className={cn(
											buttonVariants({ variant: "ghost" }),
											"h-auto min-h-11 w-full justify-start gap-3 whitespace-normal px-3 py-2.5 text-left font-normal",
											active === id
												? "bg-accent font-medium text-accent-foreground"
												: "text-muted-foreground",
										)}
										onClick={(event) => {
											if (
												event.metaKey ||
												event.ctrlKey ||
												event.altKey ||
												event.shiftKey ||
												event.button !== 0
											)
												return;
											event.preventDefault();
											selectSection(id);
										}}
									>
										<Icon className="size-4 shrink-0" aria-hidden />
										{label}
									</a>
								</li>
							))}
						</ul>
						{canManage ? (
							<div className="mt-4 border-t border-border pt-4">
								<GuardedLink
									href="/app/audit"
									className={cn(
										buttonVariants({ variant: "ghost" }),
										"min-h-11 w-full justify-start gap-3 text-muted-foreground",
									)}
								>
									<ScrollText className="size-4" aria-hidden />
									操作记录
									<ArrowUpRight className="ml-auto size-3.5" aria-hidden />
								</GuardedLink>
							</div>
						) : null}
					</nav>
					<div className="min-w-0 max-w-3xl" key={active}>
						{!active ? (
							<p role="status" className="text-sm text-muted-foreground">
								加载设置…
							</p>
						) : null}
						{active === "ask-settings" ? (
							<WorkspaceAskSettingsPanel onStateChange={reportState} />
						) : null}
						{active === "members" ? (
							<WorkspaceMembersPanel onStateChange={reportState} />
						) : null}
						{active === "integrations" ? (
							<WorkspaceIntegrationKeysPanel onStateChange={reportState} />
						) : null}
						{active === "notifications" ? (
							<WorkspaceNotificationsPanel onStateChange={reportState} />
						) : null}
						{active === "service" ? <WorkspaceServicePanel /> : null}
					</div>
					{canManage ? (
						<GuardedLink
							href="/app/audit"
							className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground lg:hidden"
						>
							<ScrollText className="size-4" aria-hidden />
							操作记录
							<ArrowUpRight className="size-3.5" aria-hidden />
						</GuardedLink>
					) : null}
				</div>
			</div>
		</div>
	);
}

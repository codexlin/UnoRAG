"use client";

import { ArrowUpRight, ScrollText } from "lucide-react";
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
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const SECTIONS = [
	{
		id: "ask-settings",
		label: ["问答策略", "Ask policy"],
	},
	{ id: "members", label: ["成员与邀请", "Members and invites"] },
	{ id: "integrations", label: ["集成密钥", "Service keys"] },
	{
		id: "notifications",
		label: ["邮件通知", "Email notifications"],
		adminOnly: true,
	},
	{ id: "service", label: ["服务状态", "Service status"] },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
	const t = useInterfaceText();
	const { identity, can } = useSession();
	const canManage = can("manageMembers");
	const sections = SECTIONS.filter(
		(section) => !("adminOnly" in section) || canManage,
	);
	const sectionOptions = sections.map(({ id, label }) => ({
		value: id,
		label: t(label[0], label[1]),
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
		<div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-5 pb-6 sm:px-6 md:overflow-hidden md:pb-0 lg:px-8">
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-4 md:min-h-0 md:flex-1 md:overflow-hidden">
				<header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<h2 className="text-2xl font-medium">
							{t("工作区设置", "Workspace settings")}
						</h2>
						<p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
							{identity.workspaceName}
						</p>
					</div>
					{canManage ? (
						<GuardedLink
							href="/app/audit"
							className={cn(
								buttonVariants({ variant: "outline" }),
								"h-11 gap-2 text-sm font-medium md:h-9",
							)}
						>
							<ScrollText className="size-4 shrink-0" aria-hidden />
							<span>{t("操作记录", "Audit log")}</span>
							<ArrowUpRight
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden
							/>
						</GuardedLink>
					) : null}
				</header>

				<div className="min-w-0 shrink-0 sm:hidden">
					<label htmlFor="settings-section" className="sr-only">
						{t("设置分区", "Settings section")}
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
							aria-label={t("设置分区", "Settings section")}
							className="h-11 w-full min-w-0"
						>
							<SelectValue placeholder={t("加载设置…", "Loading settings…")} />
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
					aria-label={t("设置分区", "Settings section")}
					className="hidden min-w-0 shrink-0 overflow-x-auto border-b border-border sm:flex"
				>
					<ul className="flex min-w-max items-center gap-4">
						{sections.map(({ id, label }) => (
							<li key={id}>
								<a
									href={`#${id}`}
									aria-current={active === id ? "page" : undefined}
									aria-disabled={panelState.busy || undefined}
									className={cn(
										"inline-flex min-h-11 items-center border-b-2 px-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring md:min-h-10",
										active === id
											? "border-evidence text-evidence"
											: "border-transparent text-muted-foreground hover:text-foreground",
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
									{t(label[0], label[1])}
								</a>
							</li>
						))}
					</ul>
				</nav>

				<div
					className="min-h-0 min-w-0 flex-1 overflow-y-auto pt-2 pb-8 md:pr-1 md:[scrollbar-gutter:stable]"
					key={active}
				>
					{!active ? (
						<p role="status" className="text-sm text-muted-foreground">
							{t("加载设置…", "Loading settings…")}
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
			</div>
		</div>
	);
}

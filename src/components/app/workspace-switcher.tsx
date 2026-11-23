"use client";

import {
	Building2,
	Check,
	ChevronsUpDown,
	LoaderCircle,
	Plus,
	RotateCcw,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useNavigationGuard } from "@/components/app/navigation-guard";
import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { Textarea } from "@/components/ui/textarea";
import { createClientId } from "@/lib/client-id";
import { useInterfaceText } from "@/lib/i18n/provider";
import { roleLabel } from "@/lib/session-types";
import { cn } from "@/lib/utils";

type WorkspaceItem = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	status: string;
	role: string;
	current: boolean;
};

type WorkspaceListResponse = {
	items: WorkspaceItem[];
	can_create: boolean;
};

async function readError(
	response: Response,
	t: ReturnType<typeof useInterfaceText>,
): Promise<string> {
	try {
		const body = (await response.json()) as { detail?: unknown };
		if (typeof body.detail === "string") return body.detail;
	} catch {
		// Fall through to a stable user-facing message.
	}
	return t(
		`请求失败（HTTP ${response.status}）`,
		`Request failed (HTTP ${response.status})`,
	);
}

export function WorkspaceSwitcher() {
	const t = useInterfaceText();
	const { isMobile } = useSidebar();
	const { identity } = useSession();
	const { allowNavigation, setGuard } = useNavigationGuard();
	const [items, setItems] = useState<WorkspaceItem[]>([]);
	const [canCreate, setCanCreate] = useState(false);
	const [loading, setLoading] = useState(true);
	const [switchingId, setSwitchingId] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	const [error, setError] = useState<string | null>(null);
	const createRequestId = useRef<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const loadWorkspaces = useCallback(async () => {
		setLoading(true);
		try {
			const response = await fetch("/api/workspaces", { cache: "no-store" });
			if (!response.ok) throw new Error(await readError(response, t));
			const payload = (await response.json()) as WorkspaceListResponse;
			setItems(payload.items);
			setCanCreate(payload.can_create);
			setError(null);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t("工作区列表加载失败", "Couldn't load workspaces"),
			);
		} finally {
			setLoading(false);
		}
	}, [t]);

	useEffect(() => {
		void loadWorkspaces();
	}, [loadWorkspaces]);

	const switchWorkspace = useCallback(
		async (workspaceId: string) => {
			if (workspaceId === identity.workspaceId || switchingId) return;
			setSwitchingId(workspaceId);
			setError(null);
			try {
				const response = await fetch("/api/auth/session/workspace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ workspace_id: workspaceId }),
				});
				if (!response.ok) throw new Error(await readError(response, t));
				setGuard({ dirty: false, busy: false });
				window.location.assign("/app/ask");
			} catch (switchError) {
				const message =
					switchError instanceof Error
						? switchError.message
						: t("工作区切换失败", "Couldn't switch workspaces");
				setError(message);
				toast.error(message);
				setSwitchingId(null);
			}
		},
		[identity.workspaceId, switchingId, setGuard, t],
	);

	async function createWorkspace(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (creating) return;
		setCreating(true);
		setError(null);
		createRequestId.current ??= createClientId();
		try {
			const response = await fetch("/api/workspaces", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": createRequestId.current,
				},
				body: JSON.stringify({
					name,
					slug: slug || undefined,
					description: description || null,
				}),
			});
			if (!response.ok) throw new Error(await readError(response, t));
			const created = (await response.json()) as WorkspaceItem;
			setCreateOpen(false);
			setName("");
			setSlug("");
			setDescription("");
			createRequestId.current = null;
			await switchWorkspace(created.id);
		} catch (createError) {
			setError(
				createError instanceof Error
					? createError.message
					: t("工作区创建失败", "Couldn't create the workspace"),
			);
		} finally {
			setCreating(false);
		}
	}

	return (
		<>
			<SidebarMenu>
				<SidebarMenuItem>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<SidebarMenuButton
									ref={triggerRef}
									size="lg"
									disabled={switchingId !== null}
									aria-busy={switchingId !== null}
									tooltip={identity.workspaceName}
									className={cn(
										"h-12 gap-2.5 rounded-lg border border-border bg-sidebar-accent/45 px-2.5 hover:bg-sidebar-accent data-open:bg-sidebar-accent",
										"group-data-[collapsible=icon]:-mx-0.5 group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-3!",
									)}
								/>
							}
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary group-data-[collapsible=icon]:size-5">
								{switchingId ? (
									<LoaderCircle
										className="size-4 animate-spin motion-reduce:animate-none"
										aria-hidden
									/>
								) : (
									<Building2 className="size-4" aria-hidden />
								)}
							</span>
							<span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:sr-only">
								<span className="text-meta text-muted-foreground">
									{t("工作区", "Workspace")}
								</span>
								<span className="truncate text-sm font-medium">
									{switchingId
										? t("正在切换…", "Switching…")
										: identity.workspaceName}
								</span>
							</span>
							<ChevronsUpDown className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
						</DropdownMenuTrigger>
						<DropdownMenuContent
							className="w-72 min-w-0"
							side={isMobile ? "bottom" : "right"}
							align="start"
							sideOffset={6}
						>
							<DropdownMenuGroup>
								<DropdownMenuLabel>
									{t("切换工作区", "Switch workspace")}
								</DropdownMenuLabel>
								{loading ? (
									<DropdownMenuItem disabled>
										<LoaderCircle className="animate-spin motion-reduce:animate-none" />
										{t("正在加载", "Loading")}
									</DropdownMenuItem>
								) : (
									items.map((item) => (
										<DropdownMenuItem
											key={item.id}
											onClick={() => {
												if (item.id === identity.workspaceId) return;
												const switchTo = () => {
													void switchWorkspace(item.id);
												};
												if (allowNavigation(switchTo)) switchTo();
											}}
											disabled={switchingId !== null}
											className="gap-2"
											aria-current={
												item.id === identity.workspaceId ? "true" : undefined
											}
										>
											<Check
												className={cn(
													"size-4",
													item.id === identity.workspaceId
														? "opacity-100"
														: "opacity-0",
												)}
											/>
											<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
												{item.name}
											</span>
											<span className="text-meta text-muted-foreground">
												{roleLabel(item.role)}
											</span>
										</DropdownMenuItem>
									))
								)}
							</DropdownMenuGroup>
							{canCreate ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={() => {
											const openCreate = () => {
												setError(null);
												setCreateOpen(true);
											};
											if (allowNavigation(openCreate)) openCreate();
										}}
									>
										<Plus />
										{t("新建工作区", "Create workspace")}
									</DropdownMenuItem>
								</>
							) : null}
							{error ? (
								<>
									<DropdownMenuSeparator />
									<p
										role="alert"
										className="px-2 py-2 text-sm text-destructive [overflow-wrap:anywhere]"
									>
										{error}
									</p>
									<DropdownMenuItem onClick={() => void loadWorkspaces()}>
										<RotateCcw aria-hidden />
										{t("重新加载工作区", "Reload workspaces")}
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</SidebarMenuItem>
			</SidebarMenu>

			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					if (!creating) setCreateOpen(open);
				}}
			>
				<DialogContent
					className="sm:max-w-md"
					initialFocus={nameRef}
					finalFocus={triggerRef}
					showCloseButton={!creating}
				>
					<form onSubmit={createWorkspace} className="contents">
						<DialogHeader>
							<DialogTitle>{t("新建工作区", "Create workspace")}</DialogTitle>
							<DialogDescription>
								{t(
									"为部门、项目或独立业务域创建数据隔离空间。",
									"Create an isolated workspace for a department, project, or business area.",
								)}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4">
							<div className="grid gap-1.5">
								<Label htmlFor="workspace-name">{t("名称", "Name")}</Label>
								<Input
									id="workspace-name"
									ref={nameRef}
									className="h-11"
									value={name}
									onChange={(event) => setName(event.target.value)}
									maxLength={256}
									required
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="workspace-slug">{t("标识", "Slug")}</Label>
								<Input
									id="workspace-slug"
									className="h-11"
									value={slug}
									onChange={(event) => setSlug(event.target.value)}
									maxLength={128}
									pattern="[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?"
									placeholder="hr-team"
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="workspace-description">
									{t("描述", "Description")}
								</Label>
								<Textarea
									id="workspace-description"
									value={description}
									onChange={(event) => setDescription(event.target.value)}
									maxLength={2000}
									rows={3}
								/>
							</div>
							{error ? (
								<p
									role="alert"
									className="text-sm text-destructive [overflow-wrap:anywhere]"
								>
									{error}
								</p>
							) : null}
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								className="h-11"
								onClick={() => setCreateOpen(false)}
								disabled={creating}
							>
								{t("取消", "Cancel")}
							</Button>
							<Button
								type="submit"
								className="h-11"
								aria-busy={creating}
								disabled={creating || !name.trim()}
							>
								{creating ? (
									<LoaderCircle
										className="animate-spin motion-reduce:animate-none"
										aria-hidden
									/>
								) : (
									<Plus aria-hidden />
								)}
								{creating
									? t("创建中…", "Creating…")
									: t("创建并进入", "Create and enter")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

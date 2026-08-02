"use client";

import {
	Building2,
	Check,
	ChevronsUpDown,
	LoaderCircle,
	Plus,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

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

async function readError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { detail?: unknown };
		if (typeof body.detail === "string") return body.detail;
	} catch {
		// Fall through to a stable user-facing message.
	}
	return `请求失败（HTTP ${response.status}）`;
}

export function WorkspaceSwitcher() {
	const { isMobile } = useSidebar();
	const { identity } = useSession();
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

	const loadWorkspaces = useCallback(async () => {
		setLoading(true);
		try {
			const response = await fetch("/api/workspaces", { cache: "no-store" });
			if (!response.ok) throw new Error(await readError(response));
			const payload = (await response.json()) as WorkspaceListResponse;
			setItems(payload.items);
			setCanCreate(payload.can_create);
			setError(null);
		} catch (loadError) {
			setError(
				loadError instanceof Error ? loadError.message : "工作区列表加载失败",
			);
		} finally {
			setLoading(false);
		}
	}, []);

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
				if (!response.ok) throw new Error(await readError(response));
				window.location.assign("/app/ask");
			} catch (switchError) {
				setError(
					switchError instanceof Error ? switchError.message : "工作区切换失败",
				);
				setSwitchingId(null);
			}
		},
		[identity.workspaceId, switchingId],
	);

	async function createWorkspace(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (creating) return;
		setCreating(true);
		setError(null);
		createRequestId.current ??= crypto.randomUUID();
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
			if (!response.ok) throw new Error(await readError(response));
			const created = (await response.json()) as WorkspaceItem;
			setCreateOpen(false);
			setName("");
			setSlug("");
			setDescription("");
			createRequestId.current = null;
			await switchWorkspace(created.id);
		} catch (createError) {
			setError(
				createError instanceof Error ? createError.message : "工作区创建失败",
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
									size="lg"
									tooltip={identity.workspaceName}
									className={cn(
										"h-12 gap-2.5 rounded-lg border border-sidebar-border bg-background/55 px-2.5 data-open:bg-sidebar-accent",
										"group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-1.5!",
									)}
								/>
							}
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary group-data-[collapsible=icon]:size-5">
								<Building2 className="size-4" aria-hidden />
							</span>
							<span className="grid min-w-0 flex-1 text-left leading-tight">
								<span className="text-meta text-muted-foreground">工作区</span>
								<span className="truncate text-sm font-medium">
									{identity.workspaceName}
								</span>
							</span>
							<ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
						</DropdownMenuTrigger>
						<DropdownMenuContent
							className="min-w-64"
							side={isMobile ? "bottom" : "right"}
							align="start"
							sideOffset={6}
						>
							<DropdownMenuGroup>
								<DropdownMenuLabel>切换工作区</DropdownMenuLabel>
								{loading ? (
									<DropdownMenuItem disabled>
										<LoaderCircle className="animate-spin" />
										正在加载
									</DropdownMenuItem>
								) : (
									items.map((item) => (
										<DropdownMenuItem
											key={item.id}
											onClick={() => {
												void switchWorkspace(item.id);
											}}
											disabled={switchingId !== null}
											className="gap-2"
										>
											<Check
												className={cn(
													"size-4",
													item.id === identity.workspaceId
														? "opacity-100"
														: "opacity-0",
												)}
											/>
											<span className="min-w-0 flex-1 truncate">
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
									<DropdownMenuItem onClick={() => setCreateOpen(true)}>
										<Plus />
										新建工作区
									</DropdownMenuItem>
								</>
							) : null}
							{error ? (
								<>
									<DropdownMenuSeparator />
									<p className="px-2 py-1.5 text-xs text-destructive">
										{error}
									</p>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</SidebarMenuItem>
			</SidebarMenu>

			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent className="sm:max-w-md">
					<form onSubmit={createWorkspace} className="contents">
						<DialogHeader>
							<DialogTitle>新建工作区</DialogTitle>
							<DialogDescription>
								为部门、项目或独立业务域创建数据隔离空间。
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4">
							<div className="grid gap-1.5">
								<Label htmlFor="workspace-name">名称</Label>
								<Input
									id="workspace-name"
									value={name}
									onChange={(event) => setName(event.target.value)}
									maxLength={256}
									required
									autoFocus
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="workspace-slug">标识</Label>
								<Input
									id="workspace-slug"
									value={slug}
									onChange={(event) => setSlug(event.target.value)}
									maxLength={128}
									pattern="[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?"
									placeholder="hr-team"
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="workspace-description">描述</Label>
								<Textarea
									id="workspace-description"
									value={description}
									onChange={(event) => setDescription(event.target.value)}
									maxLength={2000}
									rows={3}
								/>
							</div>
							{error ? (
								<p className="text-sm text-destructive">{error}</p>
							) : null}
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setCreateOpen(false)}
								disabled={creating}
							>
								取消
							</Button>
							<Button type="submit" disabled={creating || !name.trim()}>
								{creating ? (
									<LoaderCircle className="animate-spin" aria-hidden />
								) : (
									<Plus aria-hidden />
								)}
								创建并进入
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

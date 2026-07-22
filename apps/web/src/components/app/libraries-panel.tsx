"use client";

import { FileUp, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	type ApiDocument,
	type ApiLibrary,
	createLibrary,
	fetchDocuments,
	fetchLibraries,
	uploadDocument,
} from "@/lib/api";
import { MOCK_LIBRARIES } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const statusLabel = {
	ready: "就绪",
	indexing: "索引中",
	empty: "空库",
	processing: "处理中",
	failed: "失败",
} as const;

function formatUpdatedAt(value: string) {
	try {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return date.toLocaleString("zh-CN", {
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return value;
	}
}

export function LibrariesPanel() {
	const [libraries, setLibraries] = useState<ApiLibrary[]>([]);
	const [selectedId, setSelectedId] = useState<string>("");
	const [documents, setDocuments] = useState<ApiDocument[]>([]);
	const [loading, setLoading] = useState(true);
	const [uploading, setUploading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [usingMock, setUsingMock] = useState(false);
	const [displayName, setDisplayName] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	const loadLibraries = useCallback(async (signal?: AbortSignal) => {
		setLoading(true);
		setError(null);
		try {
			const items = await fetchLibraries(signal);
			setLibraries(items);
			setUsingMock(false);
			setSelectedId((prev) => prev || items[0]?.id || "");
		} catch {
			setUsingMock(true);
			setLibraries(
				MOCK_LIBRARIES.map((item) => ({
					id: item.id,
					name: item.name,
					status: item.status,
					doc_count: item.docCount,
					ready_count: item.readyCount,
					created_at: item.updatedAt,
					updated_at: item.updatedAt,
				})),
			);
			setSelectedId((prev) => prev || MOCK_LIBRARIES[0]?.id || "");
			setError("API 不可用，暂显示本地示例文库。");
		} finally {
			setLoading(false);
		}
	}, []);

	const loadDocuments = useCallback(
		async (libraryId: string, signal?: AbortSignal) => {
			if (!libraryId || usingMock) {
				setDocuments([]);
				return;
			}
			try {
				const items = await fetchDocuments(libraryId, signal);
				setDocuments(items);
			} catch {
				setDocuments([]);
			}
		},
		[usingMock],
	);

	useEffect(() => {
		const controller = new AbortController();
		void loadLibraries(controller.signal);
		return () => controller.abort();
	}, [loadLibraries]);

	useEffect(() => {
		if (!selectedId) return;
		const controller = new AbortController();
		void loadDocuments(selectedId, controller.signal);
		return () => controller.abort();
	}, [selectedId, loadDocuments]);

	async function onUploadFiles(files: FileList | null) {
		if (!files?.length || !selectedId || usingMock) return;
		setUploading(true);
		setError(null);
		setNotice(null);
		try {
			const results = [];
			for (const file of Array.from(files)) {
				const result = await uploadDocument({
					libraryId: selectedId,
					file,
					displayName: displayName.trim() || undefined,
				});
				results.push(result);
			}
			const last = results[results.length - 1];
			setNotice(
				last
					? `已上传 ${results.length} 个文件 · 显示名「${last.title}」→ ${last.status}${last.simulated ? "（stub 模拟）" : ""}`
					: null,
			);
			setDisplayName("");
			await loadLibraries();
			await loadDocuments(selectedId);
		} catch (err) {
			setError(err instanceof Error ? err.message : "上传失败");
		} finally {
			setUploading(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	}

	async function onCreateLibrary() {
		if (usingMock) return;
		const name = window.prompt("新文库名称");
		if (!name?.trim()) return;
		setCreating(true);
		setError(null);
		try {
			const created = await createLibrary({ name: name.trim() });
			setNotice(`已创建文库「${created.name}」`);
			await loadLibraries();
			setSelectedId(created.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setCreating(false);
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div className="space-y-1">
						<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
							Libraries
						</p>
						<h2 className="font-heading text-2xl font-semibold tracking-tight">
							文库
						</h2>
						<p className="max-w-lg text-sm leading-6 text-muted-foreground">
							选择文库后上传 txt / md / pdf。可填写「显示名」，避免芯片上只出现
							`学号：…` / `t` 这类文件名。live 会真正向量化；stub 可模拟就绪。
						</p>
					</div>
					<div className="flex flex-wrap items-end gap-2">
						<label className="flex min-w-[180px] flex-col gap-1">
							<span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
								显示名（可选）
							</span>
							<input
								value={displayName}
								onChange={(event) => setDisplayName(event.target.value)}
								placeholder="如：毕业设计说明书"
								disabled={usingMock}
								className="h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
							/>
						</label>
						<input
							ref={fileInputRef}
							type="file"
							accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
							className="hidden"
							multiple
							onChange={(event) => void onUploadFiles(event.target.files)}
						/>
						<Button
							type="button"
							variant="outline"
							className="rounded-md"
							disabled={loading}
							onClick={() => void loadLibraries()}
						>
							<RefreshCw data-icon="inline-start" />
							刷新
						</Button>
						<Button
							type="button"
							variant="outline"
							className="rounded-md"
							disabled={uploading || usingMock || !selectedId}
							onClick={() => fileInputRef.current?.click()}
						>
							<FileUp data-icon="inline-start" />
							{uploading ? "上传中…" : "上传"}
						</Button>
						<Button
							type="button"
							className="rounded-md"
							disabled={creating || usingMock}
							onClick={() => void onCreateLibrary()}
						>
							<Plus data-icon="inline-start" />
							新建文库
						</Button>
					</div>
				</div>

				{error ? (
					<p className="rounded-md border border-border/80 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
						{error}
					</p>
				) : null}
				{notice ? (
					<p className="rounded-md border border-cite/30 bg-cite/10 px-3 py-2 text-sm text-cite">
						{notice}
					</p>
				) : null}

				<ul className="grid gap-3 sm:grid-cols-2">
					{libraries.map((library) => (
						<li key={library.id}>
							<Card
								className={cn(
									"border-border/80 bg-card/90 shadow-sm transition-colors hover:border-border",
									selectedId === library.id &&
										"border-cite/40 ring-1 ring-cite/20",
								)}
							>
								<button
									type="button"
									className="w-full text-left"
									onClick={() => setSelectedId(library.id)}
								>
									<CardHeader className="gap-1.5">
										<div className="flex items-center justify-between gap-2">
											<CardTitle className="font-heading text-lg">
												{library.name}
											</CardTitle>
											<span
												className={cn(
													"rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase",
													library.status === "ready" &&
														"border-cite/30 bg-cite/10 text-cite",
													library.status === "indexing" &&
														"border-survey/35 bg-accent text-accent-foreground",
													library.status === "empty" &&
														"border-border bg-muted text-muted-foreground",
												)}
											>
												{statusLabel[
													library.status as keyof typeof statusLabel
												] ?? library.status}
											</span>
										</div>
										<CardDescription>
											{library.ready_count}/{library.doc_count} 文档就绪 ·
											更新于 {formatUpdatedAt(library.updated_at)}
										</CardDescription>
									</CardHeader>
								</button>
								<CardContent>
									<Link
										href="/app/ask"
										className={cn(
											buttonVariants({ variant: "outline", size: "sm" }),
											"rounded-md",
										)}
									>
										在问答台打开
									</Link>
								</CardContent>
							</Card>
						</li>
					))}
				</ul>

				{selectedId && !usingMock ? (
					<section className="space-y-3 rounded-md border border-border/80 bg-card/70 p-4">
						<div className="flex items-center justify-between gap-2">
							<h3 className="font-heading text-base font-semibold">文档</h3>
							<p className="font-mono text-[11px] text-muted-foreground">
								{selectedId}
							</p>
						</div>
						{documents.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								尚无文档。点击「上传」选择 txt / md / pdf。
							</p>
						) : (
							<ul className="divide-y divide-border/70">
								{documents.map((doc) => (
									<li
										key={doc.id}
										className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
									>
										<div className="min-w-0">
											<p className="font-medium text-foreground">{doc.name}</p>
											<p className="font-mono text-[11px] text-muted-foreground">
												原文件 {doc.filename} · chunks {doc.chunk_count} ·{" "}
												{formatUpdatedAt(doc.updated_at)}
											</p>
											{doc.error ? (
												<p className="mt-0.5 text-[11px] text-destructive">
													{doc.error}
												</p>
											) : null}
										</div>
										<span
											className={cn(
												"rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase",
												doc.status === "ready" &&
													"border-cite/30 bg-cite/10 text-cite",
												doc.status === "processing" &&
													"border-survey/35 bg-accent text-accent-foreground",
												doc.status === "failed" &&
													"border-destructive/30 bg-destructive/10 text-destructive",
											)}
										>
											{statusLabel[doc.status as keyof typeof statusLabel] ??
												doc.status}
										</span>
									</li>
								))}
							</ul>
						)}
					</section>
				) : null}
			</div>
		</div>
	);
}

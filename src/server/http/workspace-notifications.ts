import { z } from "zod";

import {
	type WorkspaceEmailSettings,
	type WorkspaceNotificationScope,
	type WorkspaceNotificationsView,
	workspaceEmailSettingsSchema,
} from "../../lib/workspace-notifications";
import { WorkspaceNotificationError } from "../observability/notification-settings";

type Identity = {
	tenantId: string;
	workspaceId: string;
	principalId: string;
	role: string;
};

type VersionCommand = WorkspaceNotificationScope & {
	actorId: string;
	expectedVersion: number;
};

type Dependencies = {
	resolveIdentity(request: Request): Promise<Identity | null>;
	read(scope: WorkspaceNotificationScope): Promise<WorkspaceNotificationsView>;
	save(
		input: VersionCommand & { settings: WorkspaceEmailSettings },
	): Promise<unknown>;
	test(input: VersionCommand): Promise<{ queued: number }>;
	appBaseUrl?: string;
};

const versionSchema = z.strictObject({ version: z.number().int().min(0) });
const saveSchema = versionSchema.extend({
	settings: workspaceEmailSettingsSchema,
});

const errorMessages: Record<string, string> = {
	workspace_not_found: "工作区不存在或已停用",
	notifications_forbidden: "当前账号无权管理通知",
	invalid_version: "配置版本无效，请刷新重试",
	version_conflict: "设置已被修改，请刷新后确认",
	invalid_settings: "通知设置无效，请检查收件邮箱",
	recipients_required: "请先保存收件邮箱",
	transport_unavailable: "邮件服务未配置或状态未知，请联系部署管理员",
	rate_limited: "测试请求过于频繁，请稍后重试",
	notifications_unavailable: "通知服务暂不可用，请稍后重试",
};

function json(body: unknown, status = 200, headers?: HeadersInit) {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("cache-control", "private, no-store");
	return Response.json(body, { status, headers: responseHeaders });
}

async function readBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("invalid JSON");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4_096) {
				await reader.cancel();
				return json({ detail: "请求内容过大" }, 413);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	} finally {
		reader.releaseLock();
	}
}

export function createWorkspaceNotificationHandlers(deps: Dependencies) {
	async function handle(action: "read" | "save" | "test", request: Request) {
		try {
			const identity = await deps.resolveIdentity(request);
			if (!identity) return json({ detail: "authentication required" }, 401);
			if (identity.role !== "owner" && identity.role !== "admin") {
				return json({ detail: "forbidden" }, 403);
			}
			const scope = {
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
			};
			if (action === "read") return json(await deps.read(scope));
			if (request.headers.get("sec-fetch-site") === "cross-site") {
				return json({ detail: "forbidden" }, 403);
			}
			const origin = request.headers.get("origin");
			if (origin && origin !== new URL(deps.appBaseUrl ?? request.url).origin) {
				return json({ detail: "forbidden" }, 403);
			}
			if (
				!/^application\/json(?:\s*;|$)/i.test(
					request.headers.get("content-type") ?? "",
				)
			) {
				return json({ detail: "application/json required" }, 415);
			}
			let body: unknown;
			try {
				body = await readBody(request);
			} catch {
				return json({ detail: "invalid JSON body" }, 400);
			}
			if (body instanceof Response) return body;
			const validated = (
				action === "save" ? saveSchema : versionSchema
			).safeParse(body);
			if (!validated.success) {
				return json({ detail: "通知设置无效，请检查邮箱和配置版本" }, 400);
			}
			const command = {
				...scope,
				actorId: identity.principalId,
				expectedVersion: validated.data.version,
			};
			if (action === "test") return json(await deps.test(command), 202);
			const settings = saveSchema.parse(validated.data).settings;
			await deps.save({ ...command, settings });
			return json(await deps.read(scope));
		} catch (error) {
			if (error instanceof WorkspaceNotificationError) {
				const code = Object.hasOwn(errorMessages, error.code)
					? error.code
					: "notifications_unavailable";
				return json(
					{ detail: errorMessages[code], code },
					error.status,
					error.retryAfterSeconds
						? { "retry-after": String(error.retryAfterSeconds) }
						: undefined,
				);
			}
			return json({ detail: "通知服务暂不可用，请稍后重试" }, 503);
		}
	}
	return {
		GET: handle.bind(null, "read"),
		PATCH: handle.bind(null, "save"),
		POST: handle.bind(null, "test"),
	};
}

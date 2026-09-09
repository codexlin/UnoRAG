export interface ErrorGuidance {
	title: string;
	cause: string;
	recovery: string;
}

const DIAGNOSTIC_MESSAGE_MAX_LENGTH = 2_000;

export function redactDiagnosticMessage(value: string | null): string | null {
	if (!value) return null;
	return value
		.replace(
			/(authorization|api[-_ ]?key|token|password|secret)(\s*[:=]\s*|\s+)[^\s,;&]+/gi,
			"$1$2[redacted]",
		)
		.replace(
			/([?&](?:api_key|token|password|secret)=)[^&\s]+/gi,
			"$1[redacted]",
		)
		.replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted]")
		.slice(0, DIAGNOSTIC_MESSAGE_MAX_LENGTH);
}

const EXACT_GUIDANCE: Record<string, ErrorGuidance> = {
	job_cancelled: {
		title: "任务已取消",
		cause: "任务收到用户取消请求，执行链路在安全检查点终止。",
		recovery: "确认取消是否符合预期；如仍需处理，请从文档详情重新发起。",
	},
	document_ingest_empty: {
		title: "没有可索引内容",
		cause: "解析结果为空，常见于无文字层扫描件、空文件或解析器未识别内容。",
		recovery: "检查原文是否可读，并尝试 MinerU/OCR 解析策略后重新索引。",
	},
	embedding_dimension_mismatch: {
		title: "向量维度不一致",
		cause: "Embedding 模型输出维度与当前 Qdrant Collection 配置不一致。",
		recovery: "核对 Embedding 模型和维度配置；变更模型后使用新索引代际重建。",
	},
	request_aborted: {
		title: "请求已中止",
		cause: "浏览器、反向代理或调用方在回答完成前关闭了连接。",
		recovery: "检查客户端超时和代理读取超时；确认后重新提问。",
	},
	stream_incomplete: {
		title: "流式回答未完整结束",
		cause: "SSE 流在终态事件写入前断开。",
		recovery:
			"使用 request ID 检查网关与模型 Provider 日志，并确认流式超时配置。",
	},
	conversation_persist_failed: {
		title: "会话持久化失败",
		cause:
			"回答已经生成并返回，但会话或消息未能写入 PostgreSQL，历史记录可能不完整。",
		recovery:
			"使用 request ID 检查数据库连接、事务冲突和容量；恢复后重新提问以补全会话记录。",
	},
	llm_overloaded: {
		title: "模型并发已满",
		cause: "当前模型 Provider 的并发槽位已耗尽。",
		recovery: "稍后重试，或调整 AI 并发上限与 Provider 容量。",
	},
	llm_queue_timeout: {
		title: "模型排队超时",
		cause: "请求等待模型并发槽位超过配置上限。",
		recovery:
			"检查流量峰值、并发限制和 Provider 延迟，必要时扩容或启用降级模型。",
	},
	qdrant_error: {
		title: "向量数据库异常",
		cause: "检索或索引期间无法完成 Qdrant 操作。",
		recovery: "检查 Qdrant 健康、磁盘、Collection 配置与网络，再重试任务。",
	},
	provider_parse_failed: {
		title: "文档解析失败",
		cause: "当前解析 Provider 无法从文件中生成可用的结构化内容。",
		recovery:
			"检查文件是否损坏、解析器健康与凭证；复杂或扫描 PDF 请启用 MinerU 后重新索引。",
	},
};

export function errorGuidance(code: string): ErrorGuidance {
	const normalized = code.trim().toLowerCase();
	const exact = EXACT_GUIDANCE[normalized];
	if (exact) return exact;
	if (normalized.includes("mineru") || normalized.includes("parser")) {
		return {
			title: "文档解析异常",
			cause: "解析 Provider 拒绝、超时或返回了不可用结果。",
			recovery:
				"检查解析器健康与凭证、原文件质量和 Provider 响应，再重新索引。",
		};
	}
	if (normalized.includes("embedding")) {
		return {
			title: "Embedding 异常",
			cause: "向量化 Provider 调用或响应校验失败。",
			recovery: "检查模型凭证、限流、维度和网络，再重试任务。",
		};
	}
	if (normalized.includes("timeout")) {
		return {
			title: "执行超时",
			cause: "阶段执行时间超过系统或上游 Provider 的时间限制。",
			recovery: "根据失败阶段检查 Provider 延迟、文件大小及代理超时，再重试。",
		};
	}
	return {
		title: "未分类运行异常",
		cause: "系统已保留错误码和关联标识，但没有匹配到更具体的故障说明。",
		recovery: "复制 request/workflow ID 查询结构化日志；确认依赖健康后再重试。",
	};
}

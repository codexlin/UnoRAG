# UnoRAG Knowledge API 与嵌入集成

> 状态：Public API v1.0 已冻结（Retrieve/Ask + Service Key）（2026-07-27）
>
> **权威契约**：[`contracts/retrieve-ask-v1.md`](./contracts/retrieve-ask-v1.md) · OpenAPI [`../contracts/public-api-v1.openapi.json`](../contracts/public-api-v1.openapi.json) · 示例 [`../examples/public-api-v1/`](../examples/public-api-v1/)
>
> 产品语境见 [PRODUCT.md](./PRODUCT.md)，产品层级见 [STRATEGY.md](./STRATEGY.md)

## 目标

让客户已有客服、售后、门户、Chat 或 Agent 接入 UnoRAG 的企业知识能力，而不必：

- 使用 UnoRAG UI
- 采用我们的通用 Agent / 工具运行时
- 把 FastAPI 裸暴露到公网

Knowledge API 是核心产品契约；Workspace、Python SDK、MCP 和 OpenAI-compatible endpoint 都是它的客户端或薄适配层。

## 已实现 vs 仍规划

| 能力 | 状态 | 说明 |
|------|------|------|
| `POST /v1/ask`（内部 HMAC） | **已实现** | 同步有据问答；浏览器经 Next BFF |
| `POST /v1/ask/stream` | **已实现** | SSE：meta / citations / token / done |
| `POST /v1/retrieve`（内部 HMAC） | **已实现** | 只返回证据包；经集成网关对外 |
| 检索执行（Ask 图内） | **已实现** | dense；可选 hybrid / rerank；表格路径 |
| Active generation + ACL 过滤 | **已实现** | 与 Workspace 共享同一数据面 |
| 浏览器经 Next BFF 调用 | **已实现** | Workspace 主路径（session） |
| **Service key** | **已实现（v1.0）** | 工作区级；hash 存储；scopes=`ask`/`retrieve`；可选 `library_ids` |
| **对外 HTTP**：`POST /api/v1/retrieve`、`POST /api/v1/ask` | **已冻结（v1.0）** | `Authorization: Bearer mk_svc_…` → Next 校验 → HMAC 转发 FastAPI |
| 控制面密钥管理 API / UI | **已实现** | owner/admin；明文只创建时返回一次 |
| 对外术语 `answer` + `ask` 兼容期 | **规划中** | 原生产品契约使用 Answer；已有 `/ask` 在明确版本周期内兼容 |
| 稳定 OpenAPI / 错误码 / citation 版本化 | **已实现（v1.0）** | `GET /api/v1/openapi.json`；仓库源文件 `contracts/public-api-v1.openapi.json` |
| 外部 Documents / Versions / Jobs API | **规划中（优先）** | 让业务系统完成知识生命周期接入，不绕过 Control Plane |
| Python SDK | **可用（0.1.0）** — [`sdk/python/`](../sdk/python/) | 薄 HTTP client（`retrieve` / `ask`），不是嵌入式第二引擎 |
| MCP server | **已交付 0.1.0**（[`sdk/mcp/`](../sdk/mcp/)） | stdio 工具 `retrieve` / `ask`，经 Python SDK 调同一 HTTP 契约 |
| OpenAI-compatible endpoint | **规划中（下一项）** | 降低迁移成本；UnoRAG 原生 citation/refusal/trace 契约仍权威 |
| OAuth-for-apps | **当前产品非目标** | 服务间集成使用可审计、可限制 scope 的 Service Key；只有明确建设公网多租户开发者平台时才重新评估 |
| 公网多租户 SaaS 网关 | **非目标（远期可选）** | 首版私有化内网集成 |

## 架构（方案 A）

```text
Customer Backend
  → Authorization: Bearer mk_svc_<…>
  → Next.js  /api/v1/retrieve | /api/v1/ask
       · 校验 service key（hash、scopes、library_ids、revoked）
       · 签发内部 HMAC（auth_source=service，principal=service:<key_id>）
  → FastAPI  /v1/retrieve | /v1/ask   （仅内网）
```

与内部 HMAC、`UNORAG_SESSION_SECRET`、用户 cookie **分离**。生产仍禁止公网裸暴露 `:8000`。

## Public API v1.0 契约

当前冻结资源面只有 Retrieve/Ask。Documents/Jobs 等规划接口不属于
v1.0，不能从路线图推断其请求或响应结构。

OpenAPI：

```http
GET /api/v1/openapi.json
```

仓库中的权威源文件：
[`../contracts/public-api-v1.openapi.json`](../contracts/public-api-v1.openapi.json)。

### 契约矩阵

| 维度 | v1.0 决策 |
|------|-----------|
| 鉴权 | Service Key；`ask` / `retrieve` scope；可选 Library allow-list |
| 输入 | JSON object；字段白名单；未知字段返回 `400 invalid_request` |
| 内部策略 | 客户不能传 `ask_overrides` 或算法旋钮；网关注入 Workspace 策略 |
| Retrieve alias | `question` 暂作 `query` 的 deprecated 兼容别名；二者不能同时出现 |
| Citation | 只返回稳定展示字段；不暴露完整 chunk body、tenant、generation |
| Debug | `retrieval_debug` 不属于外部契约 |
| 关联 ID | 每次请求由网关生成；响应头 `X-Request-Id`；成功体 `trace_id`；错误体 `error.request_id` |
| 版本标记 | 响应头 `X-UnoRAG-Api-Version: 1`；成功体 `api_version: "v1"` |
| 错误 | 统一 `error.code/message/request_id/retryable/details?` |
| 边界 | JSON body 最大 65,536 bytes；问句最大 4,000 字符；`top_k` 1–50 |
| 超时 | 网关等待数据面最多 60 秒；超时返回 `504 upstream_timeout` |
| 流式 | 不属于外部 v1.0 路径；事件名已在契约文档冻结供未来 `/answer/stream`；内部 Workspace SSE ≠ 公开路径 |
| 限流 | `429 rate_limit_exceeded` 已冻结；可选进程内限流 `UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE`；集群级用 Redis/Ingress |
| 审计 / usage | `audit_logs`：`knowledge.retrieve` / `knowledge.ask`；stdout `knowledge.api.usage`；token ledger 后置 |

### 鉴权头

```http
Authorization: Bearer mk_svc_<secret>
```

也接受：`X-UnoRAG-Service-Key: mk_svc_<secret>`。新集成应使用标准
`Authorization` 头。

### Retrieve（只检索）

```http
POST /api/v1/retrieve
Content-Type: application/json
Authorization: Bearer mk_svc_…

{
  "query": "病假证明几天内补交？",
  "library_id": "<rag_library_id>",
  "top_k": 6,
  "filters": {
    "record_type": "chunk",
    "doc_id": "<optional-document-id>",
    "table_id": "<optional-table-id>",
    "document_version_id": "<optional-version-id>"
  }
}
```

也可传 `question`（网关会规范为 `query`）。

稳定响应：

```json
{
  "api_version": "v1",
  "trace_id": "f43f...",
  "query": "病假证明几天内补交？",
  "library_id": "lib_xxx",
  "citations": [],
  "refused": true,
  "refuse_reason": "no_matching_evidence",
  "retrieval_mode": "hybrid"
}
```

### Ask（有据问答；未来原生术语为 Answer）

```http
POST /api/v1/ask
Content-Type: application/json
Authorization: Bearer mk_svc_…

{
  "question": "病假证明几天内补交？",
  "library_id": "<rag_library_id>",
  "session_id": "customer-opaque-id"
}
```

稳定响应：

```json
{
  "api_version": "v1",
  "trace_id": "f43f...",
  "session_id": "customer-opaque-id",
  "question": "病假证明几天内补交？",
  "answer": "……",
  "citations": [],
  "refused": false,
  "refuse_reason": null,
  "retrieval_mode": "hybrid"
}
```

流式 Ask 不属于外部 v1.0。内部 `/api/rag/v1/ask/stream` 使用用户
Session，不能当作 Service Key 集成接口。

Citation v1.0 只包含：

```text
id · index · title · snippet · score
document_id · filename
page · page_start · page_end · section_path
table_id · row_start · row_end · record_type
```

可能不存在的定位字段固定返回 `null`。

迁移原则：

- 新版外部契约计划提供 `/api/v1/answer` 与 `/api/v1/answer/stream`。
- `/api/v1/ask` 不会无提示移除；兼容周期和废弃响应头须写入版本化契约。
- 内部 LangGraph、代码类名和历史字段可继续使用 Ask，不要求一次性重命名实现细节。

### 错误契约

所有网关错误使用同一结构：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "query is required",
    "request_id": "f43f...",
    "retryable": false,
    "details": {
      "field": "query"
    }
  }
}
```

稳定错误类别：

| HTTP | 常见 code | 是否通常可重试 |
|------|-----------|----------------|
| 400 | `invalid_request` | 否 |
| 401 | `authentication_required` / `authentication_failed` | 否 |
| 403 | `insufficient_scope` / `library_access_denied` | 否 |
| 413 | `payload_too_large` | 否 |
| 415 | `unsupported_media_type` | 否 |
| 429 | `rate_limit_exceeded` | 是，遵循 `Retry-After` |
| 502 | `upstream_unavailable` / `invalid_upstream_response` | 是 |
| 503 | `service_unavailable` / `policy_unavailable` / `authentication_backend_unavailable` / `gateway_misconfigured` | 是 |
| 504 | `upstream_timeout` | 是 |

上游内部错误名不会透传为公共 `error.code`；网关只返回 OpenAPI
`ErrorCode` 中冻结的枚举，避免数据面实现细节意外成为兼容承诺。

所有成功和错误响应都包含：

```http
X-Request-Id: <uuid>
X-UnoRAG-Api-Version: 1
```

### 控制面：密钥管理（owner/admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/workspace/keys` | 列表（无明文） |
| `POST` | `/api/workspace/keys` | 创建；响应含一次性 `key` |
| `DELETE` | `/api/workspace/keys/:id` | 吊销 |
| `POST` | `/api/workspace/keys/:id/revoke` | 吊销别名 |

创建 body 示例：

```json
{
  "name": "客服助手",
  "scopes": ["ask", "retrieve"],
  "library_ids": ["lib_xxx"]
}
```

- `scopes` 默认 `["ask","retrieve"]`
- `library_ids` 省略或空 = 工作区内全部文库（仍受文档 ACL / active generation 约束）
- UI：设置页「Integration」面板

### 手测（本机）

前置：`pnpm --filter web db:migrate`（含 `workspace_service_keys`）、web + api 已起、INTERNAL_AUTH 对齐。

```bash
# 1. 浏览器登录为 owner/admin → 设置 → 创建集成密钥，复制 mk_svc_…

# 2. retrieve
curl -sS -X POST "$APP/api/v1/retrieve" \
  -H "Authorization: Bearer mk_svc_…" \
  -H "content-type: application/json" \
  -d '{"query":"病假几天？","library_id":"<rag_library_id>"}'

# 3. ask
curl -sS -X POST "$APP/api/v1/ask" \
  -H "Authorization: Bearer mk_svc_…" \
  -H "content-type: application/json" \
  -d '{"question":"病假几天？","library_id":"<rag_library_id>"}'

# 4. 吊销后应 401
```

## v1.0 边界

1. 无外部文档生命周期 API、OpenAI-compatible endpoint、OAuth-for-apps、对外流式 ask（Python SDK + MCP 0.1.0 已提供 retrieve/ask 薄客户端）。
2. Service principal 为 `service:<key_id>`：可见 `acl_scope=workspace` 的文档；**不会**自动获得仅绑定某用户的 restricted ACL。
3. 密钥绑定**当前工作区**；不跨工作区。
4. `429` 契约已冻结；单节点可设 `UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE`；多副本仍建议 Redis/Ingress。
5. 客户应用应只在**服务端**持有 key，不要放进浏览器。
6. curl 示例见 [`../examples/public-api-v1/`](../examples/public-api-v1/)。

## 目标 Knowledge API 资源面（规划）

以下是产品方向，不是当前已实现接口：

```text
POST   /api/v1/knowledge-bases
GET    /api/v1/knowledge-bases/{id}

POST   /api/v1/documents
GET    /api/v1/documents/{id}
GET    /api/v1/documents/{id}/versions
DELETE /api/v1/documents/{id}

GET    /api/v1/jobs/{id}

POST   /api/v1/retrieve
POST   /api/v1/answer
POST   /api/v1/answer/stream

POST   /api/v1/feedback
GET    /api/v1/traces/{trace_id}
```

约束：

1. Documents/Versions/Jobs 必须复用 Next Control Plane、对象存储和 `app.jobs`，不得复活 FastAPI ingest。
2. 所有写接口提供 idempotency key、明确的异步 Job 和版本化错误码。
3. Retrieve/Answer 共享 active generation、ACL、citation、refusal 和 trace。
4. Trace Debug 默认不返回原文、密钥或内部高敏字段。
5. Service Key scopes 按资源扩展，例如 `documents:write`、`documents:read`、`retrieve`、`answer`，不得用单个全能 scope。

## Python SDK（v0.1.0）

包路径：[`sdk/python/`](../sdk/python/)。安装：`cd sdk/python && pip install -e .`

SDK 保持薄、可替换；字段对齐冻结契约（`library_id`，非规划稿里的 `knowledge_base`）：

```python
from unorag import UnoRAG

client = UnoRAG(
    base_url="https://knowledge.example.internal",
    service_key="mk_svc_...",
)

evidence = client.retrieve(
    library_id="product-support",
    query="设备出现 E37 应如何处理？",
)

answer = client.ask(
    library_id="product-support",
    question="设备出现 E37 应如何处理？",
)
```

0.1.0 已具备：

- Service Key 鉴权 + `X-UnoRAG-Api-Version: 1`
- 同步 `retrieve` / `ask`
- dataclass 响应模型 + 稳定错误码映射

后续可选：异步 client、SSE、重试策略（仍不得嵌入引擎）。

SDK 不负责：

- 启动本地 Qdrant/PostgreSQL
- 复制完整解析与检索引擎
- 绕过 Control Plane 写入向量

## MCP Server（v0.1.0）

包路径：[`sdk/mcp/`](../sdk/mcp/)。安装：`cd sdk/mcp && pip install -e .`；运行：`unorag-mcp`（stdio）。

工具与 HTTP 1:1（经 Python SDK，不嵌入引擎）：

| MCP tool | HTTP |
|----------|------|
| `retrieve` | `POST /api/v1/retrieve` |
| `ask` | `POST /api/v1/ask` |

鉴权与 SDK 相同：`UNORAG_BASE_URL` + `UNORAG_SERVICE_KEY`（`mk_svc_…`），请求带 `X-UnoRAG-Api-Version: 1`。Cursor / Claude 配置见 [`sdk/mcp/README.md`](../sdk/mcp/README.md)。

删除文档、修改 ACL、成员管理等高影响动作不进入首版 MCP。

## OpenAI-compatible 方向（规划 · 下一项）

兼容层用于让现有 OpenAI client 快速试用，例如将 `model` 映射到指定 knowledge base。标准响应无法完整表达 UnoRAG 的 citation、refusal 和 trace，因此兼容响应需使用扩展字段，同时保留原生 API：

```json
{
  "choices": [],
  "unorag": {
    "citations": [],
    "refused": false,
    "refuse_reason": null,
    "trace_id": "..."
  }
}
```

OpenAI-compatible endpoint 不成为新的业务事实源，也不允许绕过 Service Key、ACL 或 active generation。

## 集成方 checklist

- [x] 仅服务端持有 service key（产品约定）
- [x] 明确 library / workspace 范围（可选 `library_ids`）
- [ ] 处理 `refused` 与空 citations（UI 提示「资料未覆盖」）
- [ ] 引用展示至少：文档名 + 片段
- [ ] 超时与限流按私有化容量设置
- [x] v1 网关不返回 `retrieval_debug`、完整 chunk body 或租户内部字段

## 反模式

| 反模式 | 正确做法 |
|--------|----------|
| 浏览器直连 FastAPI | 经 `/api/v1/*` 或客户自有 BFF |
| 用 internal HMAC secret 当客户 key | 独立 `mk_svc_` service key |
| 调用 `/v1/ingest` 上传 | 控制面文档 API |
| 期望 UnoRAG 托管客户 Agent 工具链 | Knowledge API 只提供可治理的知识能力 |
| 在 Python SDK 内复制完整引擎 | SDK 只调用统一 Knowledge API |
| MCP 自己访问 Qdrant | MCP 通过 Service Key 调用 Knowledge API |
| 每轮强制写 UnoRAG archive | 客户可自管消息 |

## 与 Workspace 共享的内核

```text
同一 Qdrant + active generation + ACL
同一 Ask 图与 citation/refuse 语义
同一工作区 ask 默认（可被请求级 overrides 覆盖）
```

差异仅在**调用面与身份模型**，不在两套检索真相。

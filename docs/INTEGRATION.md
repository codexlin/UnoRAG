# MeriKnow Knowledge API 与嵌入集成

> 状态：Retrieve/Ask MVP 已落地（Next 网关 + service key）（2026-07-26）
>
> 产品语境见 [PRODUCT.md](./PRODUCT.md)，产品层级见 [STRATEGY.md](./STRATEGY.md)

## 目标

让客户已有客服、售后、门户、Chat 或 Agent 接入 MeriKnow 的企业知识能力，而不必：

- 使用 MeriKnow UI
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
| **Service key** | **已实现（MVP）** | 工作区级；hash 存储；scopes=`ask`/`retrieve`；可选 `library_ids` |
| **对外 HTTP**：`POST /api/v1/retrieve`、`POST /api/v1/ask` | **已实现（方案 A）** | `Authorization: Bearer mk_svc_…` → Next 校验 → HMAC 转发 FastAPI |
| 控制面密钥管理 API / UI | **已实现** | owner/admin；明文只创建时返回一次 |
| 对外术语 `answer` + `ask` 兼容期 | **规划中** | 原生产品契约使用 Answer；已有 `/ask` 在明确版本周期内兼容 |
| 稳定 OpenAPI / 错误码 / citation 版本化 | **规划中（优先）** | 客户集成合同硬化 |
| 外部 Documents / Versions / Jobs API | **规划中（优先）** | 让业务系统完成知识生命周期接入，不绕过 Control Plane |
| Python SDK | **规划中（HTTP 契约后）** | API client，不是嵌入式第二引擎 |
| MCP server | **规划中（SDK 同期或后置）** | HTTP 契约稳定后的只读知识工具适配 |
| OpenAI-compatible endpoint | **规划中（后置）** | 降低迁移成本；MeriKnow 原生 citation/refusal/trace 契约仍权威 |
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

与内部 HMAC、`MERIKNOW_SESSION_SECRET`、用户 cookie **分离**。生产仍禁止公网裸暴露 `:8000`。

## 对外契约（已实现 MVP）

当前 MVP 资源面只有 Retrieve/Ask 和 Service Key 管理。下文必须按「已实现」理解，不代表规划中的完整 Knowledge API 已冻结。

### 鉴权头

```http
Authorization: Bearer mk_svc_<secret>
```

也接受：`X-MeriKnow-Service-Key: mk_svc_<secret>`。

### Retrieve（只检索）

```http
POST /api/v1/retrieve
Content-Type: application/json
Authorization: Bearer mk_svc_…

{
  "query": "病假证明几天内补交？",
  "library_id": "<rag_library_id>",
  "top_k": 6,
  "filters": { "document_ids": [] }
}
```

也可传 `question`（网关会规范为 `query`）。

响应要素：`citations[]`、`refused` / `refuse_reason`、`retrieval_mode`、`retrieval_debug`（勿原样暴露给终端用户）。

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

响应字段与现网 ask 对齐：`answer`、`citations[]`、`refused`、`refuse_reason` 等。流式 ask 本 MVP 未对外暴露（仍可用内部 `/api/rag/v1/ask/stream` + session）。

迁移原则：

- 新版外部契约计划提供 `/api/v1/answer` 与 `/api/v1/answer/stream`。
- `/api/v1/ask` 不会无提示移除；兼容周期和废弃响应头须写入版本化契约。
- 内部 LangGraph、代码类名和历史字段可继续使用 Ask，不要求一次性重命名实现细节。

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

## MVP 限制

1. 无外部文档生命周期 API、Python SDK、MCP、OpenAI-compatible endpoint、OAuth-for-apps、对外流式 ask。
2. Service principal 为 `service:<key_id>`：可见 `acl_scope=workspace` 的文档；**不会**自动获得仅绑定某用户的 restricted ACL。
3. 密钥绑定**当前工作区**；不跨工作区。
4. 限流 / 审计明细 / OpenAPI 冻结仍后置。
5. 客户应用应只在**服务端**持有 key，不要放进浏览器。

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

## Python SDK 方向（规划）

SDK 保持薄、可替换、可生成：

```python
from meriknow import MeriKnow

client = MeriKnow(
    base_url="https://knowledge.example.internal",
    api_key="mk_svc_...",
)

evidence = client.retrieve(
    knowledge_base="product-support",
    query="设备出现 E37 应如何处理？",
)

answer = client.answer(
    knowledge_base="product-support",
    question="设备出现 E37 应如何处理？",
)
```

SDK 职责：

- 鉴权、超时、重试和幂等键
- Pydantic 类型
- 同步/异步 client
- SSE 消费
- 标准错误映射

SDK 不负责：

- 启动本地 Qdrant/PostgreSQL
- 复制完整解析与检索引擎
- 绕过 Control Plane 写入向量

## MCP 方向（规划）

首版只读工具：

```text
search_knowledge
answer_with_sources
get_source
```

MCP Server 使用独立 Service Key 调用 Knowledge API。删除文档、修改 ACL、成员管理等高影响动作不进入首版 MCP。

## OpenAI-compatible 方向（规划）

兼容层用于让现有 OpenAI client 快速试用，例如将 `model` 映射到指定 knowledge base。标准响应无法完整表达 MeriKnow 的 citation、refusal 和 trace，因此兼容响应需使用扩展字段，同时保留原生 API：

```json
{
  "choices": [],
  "meriknow": {
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
- [ ] 不把 `retrieval_debug` 原样暴露给终端用户

## 反模式

| 反模式 | 正确做法 |
|--------|----------|
| 浏览器直连 FastAPI | 经 `/api/v1/*` 或客户自有 BFF |
| 用 internal HMAC secret 当客户 key | 独立 `mk_svc_` service key |
| 调用 `/v1/ingest` 上传 | 控制面文档 API |
| 期望 MeriKnow 托管客户 Agent 工具链 | Knowledge API 只提供可治理的知识能力 |
| 在 Python SDK 内复制完整引擎 | SDK 只调用统一 Knowledge API |
| MCP 自己访问 Qdrant | MCP 通过 Service Key 调用 Knowledge API |
| 每轮强制写 MeriKnow archive | 客户可自管消息 |

## 与 Workspace 共享的内核

```text
同一 Qdrant + active generation + ACL
同一 Ask 图与 citation/refuse 语义
同一工作区 ask 默认（可被请求级 overrides 覆盖）
```

差异仅在**调用面与身份模型**，不在两套检索真相。

# 模式 B：RAG 嵌入集成

> 状态：MVP 已落地（方案 A：Next 网关 + service key）（2026-07-25）  
> 产品语境见 [PRODUCT.md](./PRODUCT.md)

## 目标

让客户**已有助手**接入 MeriKnow 的有据检索与问答，而不必：

- 使用 MeriKnow UI
- 采用我们的通用 Agent / 工具运行时
- 把 FastAPI 裸暴露到公网

## 已实现 vs 仍规划

| 能力 | 状态 | 说明 |
|------|------|------|
| `POST /v1/ask`（内部 HMAC） | **已实现** | 同步有据问答；浏览器经 Next BFF |
| `POST /v1/ask/stream` | **已实现** | SSE：meta / citations / token / done |
| `POST /v1/retrieve`（内部 HMAC） | **已实现** | 只返回证据包；经集成网关对外 |
| 检索执行（Ask 图内） | **已实现** | dense；可选 hybrid / rerank；表格路径 |
| Active generation + ACL 过滤 | **已实现** | 与模式 A 同一数据面 |
| 浏览器经 Next BFF 调用 | **已实现** | 模式 A 主路径（session） |
| **Service key** | **已实现（MVP）** | 工作区级；hash 存储；scopes=`ask`/`retrieve`；可选 `library_ids` |
| **对外 HTTP**：`POST /api/v1/retrieve`、`POST /api/v1/ask` | **已实现（方案 A）** | `Authorization: Bearer mk_svc_…` → Next 校验 → HMAC 转发 FastAPI |
| 控制面密钥管理 API / UI | **已实现** | owner/admin；明文只创建时返回一次 |
| 稳定 OpenAPI / 错误码版本化 | **规划中** | 客户集成合同硬化 |
| MCP server（retrieve/ask tools） | **规划中（后置）** | HTTP 契约稳定后的薄适配 |
| OAuth-for-apps | **非目标（远期）** | 本 MVP 不做 |
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

### Ask（有据问答）

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

1. 无 OAuth-for-apps、无 MCP、无对外流式 ask。
2. Service principal 为 `service:<key_id>`：可见 `acl_scope=workspace` 的文档；**不会**自动获得仅绑定某用户的 restricted ACL。
3. 密钥绑定**当前工作区**；不跨工作区。
4. 限流 / 审计明细 / OpenAPI 冻结仍后置。
5. 客户应用应只在**服务端**持有 key，不要放进浏览器。

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
| 期望 MeriKnow 托管客户 Agent 工具链 | 模式 B 只补强 RAG |
| 每轮强制写 MeriKnow archive | 客户可自管消息 |

## 与模式 A 的共享内核

```text
同一 Qdrant + active generation + ACL
同一 Ask 图与 citation/refuse 语义
同一工作区 ask 默认（可被请求级 overrides 覆盖）
```

差异仅在**调用面与身份模型**，不在两套检索真相。

# UnoRAG Knowledge API

Knowledge API 让客户已有客服、售后、门户或 Agent 使用 UnoRAG 的权限感知检索和有据问答，
无需采用 UnoRAG Workspace UI，也不需要访问 Worker、Qdrant 或数据库。

当前公开契约是 Service Key + Retrieve / Ask v1：

```text
Customer backend
  -> Authorization: Bearer mk_svc_...
  -> Next.js /api/v1/retrieve | /api/v1/ask
  -> resolve organization/workspace/library/ACL scope
  -> native retrieval or LangGraph Ask
```

机器可读契约以 [`contracts/public-api-v1.openapi.json`](../contracts/public-api-v1.openapi.json)
为准，设计约束见 [Retrieve / Ask v1](./contracts/retrieve-ask-v1.md)。

## 当前接口

| 方法 | 路径 | Scope | 用途 |
|---|---|---|---|
| `GET` | `/api/v1/openapi.json` | 无 | 获取公开 OpenAPI |
| `POST` | `/api/v1/retrieve` | `retrieve` | 返回经过授权过滤的证据包 |
| `POST` | `/api/v1/ask` | `ask` | 返回有据答案、引用或拒答 |

外部 v1 暂不提供流式 Ask 和文档生命周期接口。Workspace 使用的 `/api/rag/*` 是 Session
接口，不属于 Service Key 公共契约。

## Service Key

Owner 或 Admin 在 Workspace 设置页创建 Service Key。Key 只在创建时显示一次，数据库只保存
hash；它绑定当前 Workspace、scope 和可选文库 allow-list。

```http
Authorization: Bearer mk_svc_<secret>
```

也兼容 `X-UnoRAG-Service-Key`，新集成应使用标准 `Authorization`。Key 只能保存在客户服务端，
不能进入浏览器、移动端包、日志或源码。

控制面接口由登录 Session 保护：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/workspace/keys` | 列出元数据，不返回 secret |
| `POST` | `/api/workspace/keys` | 创建并一次性返回 key |
| `DELETE` | `/api/workspace/keys/:id` | 吊销 |
| `POST` | `/api/workspace/keys/:id/revoke` | 吊销别名 |

```json
{
  "name": "customer-support",
  "scopes": ["ask", "retrieve"],
  "library_ids": ["lib_xxx"]
}
```

省略 `library_ids` 表示允许访问 Workspace 内文库，但仍受文档 ACL 和 active generation 限制。
Service principal 不会自动获得仅绑定某个用户的 restricted 文档权限。

## Retrieve

```bash
curl -sS -X POST "$UNORAG_URL/api/v1/retrieve" \
  -H "Authorization: Bearer $UNORAG_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "病假证明几天内补交？",
    "library_id": "lib_xxx",
    "top_k": 6
  }'
```

可选过滤字段包括 `record_type`（含 `figure`）、`doc_id`、`table_id` 和 `document_version_id`。调用方过滤只能
缩小服务端授权范围，不能扩大范围。

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

## Ask

```bash
curl -sS -X POST "$UNORAG_URL/api/v1/ask" \
  -H "Authorization: Bearer $UNORAG_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "病假证明几天内补交？",
    "library_id": "lib_xxx",
    "session_id": "customer-opaque-id"
  }'
```

```json
{
  "api_version": "v1",
  "trace_id": "f43f...",
  "session_id": "customer-opaque-id",
  "question": "病假证明几天内补交？",
  "answer": "返岗后三个工作日内补交。[1]",
  "citations": [],
  "refused": false,
  "refuse_reason": null,
  "retrieval_mode": "hybrid"
}
```

集成方必须把 `refused=true` 和空 citations 作为正常业务结果处理，不能用本地模型补写一个
无来源答案。

## Citation

公开引用只包含稳定展示字段：标题、片段、分数、文档 ID、文件名、页码、section path、
table/row 范围和 record type。不存在的定位字段返回 `null`。公共接口不暴露完整 chunk、
tenant、generation 或内部 retrieval debug。

## 错误与限额

```json
{
  "error": {
    "code": "invalid_request",
    "message": "query is required",
    "request_id": "f43f...",
    "retryable": false
  }
}
```

| HTTP | 常见 code | 处理建议 |
|---|---|---|
| 400 | `invalid_request` | 修正请求，不重试 |
| 401 | `authentication_required` / `authentication_failed` | 检查或轮换 key |
| 403 | `insufficient_scope` / `library_access_denied` | 检查 scope 与文库授权 |
| 413/415 | `payload_too_large` / `unsupported_media_type` | 修正请求 |
| 429 | `rate_limit_exceeded` | 遵循 `Retry-After` |
| 502/503/504 | upstream/service/timeout | 按 `retryable` 做有界退避 |

成功和错误响应均返回 `X-Request-Id` 与 `X-UnoRAG-Api-Version: 1`。JSON body 最大 65,536
bytes，问句最大 4,000 字符，`top_k` 范围 1-50，请求预算最多 60 秒。多副本限流应由
Redis 或 Ingress 统一执行。

## 版本边界

v1 只冻结 Retrieve / Ask，不包含：

- Documents / Versions / Jobs 公共生命周期 API；
- Service Key 流式 Ask；
- OAuth-for-apps 或跨 Workspace key；
- OpenAI-compatible endpoint；
- retrieval debug 或原始 chunk 导出。

未来文档生命周期 API 必须复用现有 Next.js 产品边界、对象存储、`app.jobs`、ACL 和版本模型，
并提供 idempotency key 与异步 Job；不会建设旁路 ingest 或第二套业务事实。

## 集成检查

- [ ] Key 只保存在服务端，并有轮换和吊销流程
- [ ] Key scope 与文库 allow-list 遵循最小权限
- [ ] UI 正确处理拒答、空引用、限流和超时
- [ ] 引用至少展示文档名与证据片段
- [ ] 日志记录 `X-Request-Id`，不记录 key 或完整敏感文档
- [ ] 客户系统不直连 Worker、Qdrant 或数据库

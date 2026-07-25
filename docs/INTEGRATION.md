# 模式 B：RAG 嵌入集成

> 状态：部分已实现 / 对外契约规划中（2026-07-25）  
> 产品语境见 [PRODUCT.md](./PRODUCT.md)

## 目标

让客户**已有助手**接入 MeriKnow 的有据检索与问答，而不必：

- 使用 MeriKnow UI
- 采用我们的通用 Agent / 工具运行时
- 把 FastAPI 裸暴露到公网

## 已实现 vs 规划中

| 能力 | 状态 | 说明 |
|------|------|------|
| `POST /v1/ask` | **已实现** | 同步有据问答；需内部 HMAC RequestContext |
| `POST /v1/ask/stream` | **已实现** | SSE：meta / citations / token / done |
| 检索执行（Ask 图内） | **已实现** | dense；可选 hybrid / rerank；表格路径 |
| Active generation + ACL 过滤 | **已实现** | 与模式 A 同一数据面 |
| 浏览器经 Next BFF 调用 | **已实现** | 模式 A 主路径 |
| 独立 `POST /v1/retrieve` | **规划中** | 只返回证据包，不生成答案；便于客户自有 LLM |
| Service key / 应用身份 | **规划中** | 与浏览器 session、内部 HMAC 分离 |
| 稳定对外 OpenAPI 版本 | **规划中** | 错误码、citation schema、分页 |
| MCP server（retrieve/ask tools） | **规划中（后置）** | HTTP 契约稳定后的薄适配 |
| 公网多租户 SaaS 网关 | **非目标（远期可选）** | 首版私有化内网集成 |

## 当前可集成方式（内网、受控）

适用于：同一私有部署内，客户网关或服务端代表用户调用。

```text
Customer Backend
  →（今日）复用 Next 签发模型，或开发态直连 FastAPI
  → POST /v1/ask | /v1/ask/stream
  → 解析 citations / refused / retrieval_debug
```

约束：

1. **生产禁止**把 `:8000` 暴露给终端用户或公网。
2. 今日鉴权是 **内部 RequestContext**（为 BFF/worker 设计），不是客户 App 的长期 service key。
3. 入库仍建议走控制面文档生命周期；不要调用已 410 的 `/v1/ingest*`。

开发联调示例见 [DEV.md](./DEV.md) 与 `apps/api/README.md`。

## 规划中的对外契约方向

以下为团队对齐的**方向**，实现前可改；对外承诺以发布说明为准。

### 1. 身份

```text
Authorization: Bearer mk_svc_<...>
或
X-MeriKnow-Service-Key: ...
```

- 绑定 organization / 可选 workspace 范围
- 权限：只读检索、ask、（可选）指定 library 列表
- 与 `MERIKNOW_SESSION_SECRET` / 用户 cookie **分离**
- 轮换、吊销、审计

### 2. Retrieve（只检索）

```http
POST /v1/retrieve
Content-Type: application/json

{
  "query": "病假证明几天内补交？",
  "library_ids": ["..."],
  "top_k": 6,
  "filters": { "document_ids": [] }
}
```

期望响应要素：

| 字段 | 用途 |
|------|------|
| `chunks[]` | id、library/document/version、score、snippet、section/page |
| `retrieval_plan` | 可选；便于客户侧调试 |
| `refused` / `reason` | 无命中等（若在 retrieve 层裁决） |

客户可用自有 LLM 生成答案，但应遵守「无证据不编造」；我们也可只提供证据包。

### 3. Ask（有据问答）

与现网对齐的稳定子集：

```http
POST /v1/ask
{
  "question": "...",
  "library_id": "...",
  "session_id": "customer-opaque-id",
  "messages": [ { "role": "user|assistant", "content": "..." } ],
  "ask_overrides": { "hybrid_enabled": true }
}
```

响应稳定字段（方向）：`answer`、`citations[]`、`refused`、`refuse_reason`、`rewritten_query`、`thread_id?`。

流式：保留 SSE 事件名版本协商（`v1`）。

### 4. MCP（后置）

在 HTTP 契约冻结后提供：

| Tool | 映射 |
|------|------|
| `meriknow_retrieve` | `/v1/retrieve` |
| `meriknow_ask` | `/v1/ask` |

不做：任意 SQL、任意 shell、开放插件市场。

## 集成方 checklist（规划落地后）

- [ ] 仅服务端持有 service key
- [ ] 明确 library / workspace 范围
- [ ] 处理 `refused` 与空 citations（UI 提示「资料未覆盖」）
- [ ] 引用展示至少：文档名 + 片段；可链回原文页/节
- [ ] 超时与限流按私有化容量设置
- [ ] 不把 `retrieval_debug` 原样暴露给终端用户（可留在内部日志）

## 反模式

| 反模式 | 正确做法 |
|--------|----------|
| 浏览器直连 FastAPI | 经客户 BFF 或未来网关 |
| 用 internal HMAC secret 当客户 key | 独立 service key |
| 调用 `/v1/ingest` 上传 | 控制面文档 API / 未来受控 ingest API |
| 期望 MeriKnow 托管客户 Agent 工具链 | 模式 B 只补强 RAG |
| 每轮强制写 MeriKnow archive | 客户可自管消息；需要时再调归档 API |

## 与模式 A 的共享内核

```text
同一 Qdrant + active generation + ACL
同一 Ask 图与 citation/refuse 语义
同一工作区 ask 默认（可被请求级 overrides 覆盖）
```

差异仅在**调用面与身份模型**，不在两套检索真相。

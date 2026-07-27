# Public API v1.0 真实 Service Key E2E

> 日期：2026-07-27（Asia/Shanghai）  
> 结果：**PASS**  
> 产品提交：`eec8a4dcec199b50837ced13b5f7f669a1c8eec7`  
> 拓扑：本地 `deploy/compose` 私有化完整栈，edge=`http://localhost:8088`

## 目标

验证 Public API v1.0 不是仅通过单元测试，而是能通过真实数据库密钥、
Next 网关、内部 HMAC、FastAPI、Embedding、Qdrant 和 LLM 完成
Retrieve/Ask 全链路调用。

MinerU 未启动且不参与本轮：测试文档为 Markdown，使用本地解析路径。

## 被测环境

| 服务 | 结果 |
|------|------|
| PostgreSQL | healthy |
| Redis | healthy |
| Qdrant | healthy |
| FastAPI | healthy |
| lifecycle-worker | healthy |
| Web | healthy；使用本轮重建镜像 |
| Caddy | up；宿主端口 `8088` |

Web 容器与镜像 ID 一致：

```text
sha256:fe9587c75abc6eb7483a0ab71d3fc0fca8361ea6f8d7e5ff61399d69efe5e7a4
```

## 执行链路

```text
登录控制面
→ 创建两个临时 Library
→ 上传带唯一 marker 的 Markdown
→ lifecycle-worker 入库完成
→ 创建绑定 Library A、scope=ask+retrieve 的真实 Service Key
→ POST /api/v1/retrieve
→ POST /api/v1/ask
→ 反向契约与权限检查
→ 吊销密钥并验证拒绝
→ 跨 Library 隔离
→ replace 新版本
→ delete 文档
```

## 结果

| 检查项 | 结果 | 证据摘要 |
|--------|------|----------|
| Markdown 入库 | **PASS** | job `8fd74b28-48c2-47a8-9c5c-4899ad31657c` → `completed/done` |
| Public Retrieve | **PASS** | HTTP 200；2 citations；trace `7f3a5687-5cdc-4dc2-ad80-a990682816f8` |
| Public Ask | **PASS** | HTTP 200；1 citation；trace `1315fbeb-b855-44d7-b345-1129baded341` |
| 关联 ID | **PASS** | 两条成功链路均满足 body `trace_id == X-Request-Id` |
| API 版本头 | **PASS** | `X-MeriKnow-Api-Version: 1` |
| 稳定顶层 schema | **PASS** | Ask/Retrieve 响应字段与 v1.0 白名单精确相等 |
| Citation schema | **PASS** | citation 字段与 v1.0 白名单精确相等 |
| 内部字段隔离 | **PASS** | 无 `retrieval_debug`、`text/body`、tenant、generation、内部 score、`doc_id` |
| 客户端算法参数 | **PASS** | `ask_overrides` → 400 `invalid_request` |
| Library allow-list | **PASS** | 使用 Library A key 请求 Library B → 403 `library_access_denied` |
| Scope | **PASS** | retrieve-only key 调 Ask → 403 `insufficient_scope` |
| 密钥吊销 | **PASS** | 吊销后调用 → 401 `authentication_failed` |
| 跨 Library 隔离 | **PASS** | Library B 未引用或回答 Library A marker |
| replace | **PASS** | 新版本 job → `completed/done` |
| delete | **PASS** | delete job → `completed/done` |
| 临时密钥清理 | **PASS** | 匹配本轮 E2E 命名且 `revoked_at IS NULL` 的记录数为 `0` |
| 结束后服务健康 | **PASS** | Compose 应用与基础设施仍健康 |

测试对象：

```text
library_a=70388677-f671-4989-a6c5-540fc35d2e97
library_b=ce55e3a0-75f5-42dd-ab0e-0947c17c22ea
document_id=f7b1c81a-3efa-4d45-b587-e02311d47fbd
```

文档已通过产品删除链路清理；Library 保留为无测试文档的控制面记录。
Service Key 明文未写入仓库、日志或报告，仅在脚本进程和权限受限的临时目录中
短暂存在，退出时目录删除；数据库中只保存 hash，且两把临时 key 均已吊销。

## 可重复执行

验收入口：

```bash
cd deploy/compose
./scripts/pilot-smoke.sh
```

脚本现在同时覆盖原有
`upload → session ask → isolation → replace → delete`，以及 Public API v1.0
真实 Service Key 的 Retrieve/Ask、契约投影、scope、Library allow-list、未知字段和
吊销检查。

## 结论

Public API v1.0 的真实授权成功路径和主要失败路径均通过本地完整栈验证。
这证明 `eec8a4d` 的 Retrieve/Ask 契约可由外部服务通过独立 Service Key 实际调用，
而不是只在 mock 或静态 OpenAPI 层成立。

仍未包含在本轮的能力：

- Redis/Ingress 生产限流执行器（仅冻结 429 契约）
- 对外流式 Answer
- Documents/Versions/Jobs 公共 API
- Python SDK / MCP / OpenAI-compatible adapter

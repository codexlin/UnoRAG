# UnoRAG 运维指南

本指南覆盖生产信号、生命周期巡检、故障处理、备份恢复和镜像发布。部署参数与安装步骤见
[DEPLOYMENT.md](./DEPLOYMENT.md)，版本放行条件见 [RELEASE.md](./RELEASE.md)。

## 关联标识

排障时应保留以下字段，并确保日志对敏感内容脱敏：

| 标识 | 用途 |
|---|---|
| `trace_id` / `request_id` | 串联 HTTP、检索、模型和结构化日志 |
| `job_id` / `workflow_id` | 串联产品任务和 DBOS 执行 |
| `document_id` / `document_version_id` / `generation_id` | 核对 active pointer、对象与向量点 |
| `organization_id` / `workspace_id` | 限定所有查询和运维动作的安全范围 |

## 日常检查

```bash
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
pnpm lifecycle:inspect

cd deploy/compose
source scripts/compose-env.sh
mk_compose ps
mk_compose --profile ops run --rm inspect-lifecycle
```

至少监控以下信号：

- Web readiness、Ask 5xx、P50/P95 延迟和并发拒绝；
- DBOS workflow queued/running/dead/stuck、Worker 心跳和重试；
- Parser、Embedding、Rerank、LLM 的错误率、延迟和限额；
- PostgreSQL 连接、锁、容量与备份状态；
- Qdrant readiness、集合容量和检索错误；
- 文档卷、备份卷和宿主机磁盘水位。

UnoRAG 输出健康接口、结构化日志和 `inspect-lifecycle`，客户应接入既有 Prometheus、日志
平台或云监控。交付时必须记录告警接收人、升级路径、日志保留期和脱敏策略。

## 生命周期故障

任务失败时先按 `job_id` 查询产品状态，再按 `workflow_id` 检查 DBOS。不得直接修改业务表
“修复”状态。确认根因消失后，通过产品重试或幂等运维命令恢复。

删除失败可重新创建持久化任务：

```bash
cd deploy/compose
source scripts/compose-env.sh
mk_compose run --rm --no-deps dbos-control \
  ./node_modules/.bin/tsx src/worker/dispatch-entry.ts \
  --retry-document-delete <failed-job-uuid>
```

故障恢复后应验证：无 dead/stuck workflow、无 pending ACL、旧 generation 不可召回、
active 文档仍能返回正确引用。

## 依赖故障原则

| 故障 | 预期行为 |
|---|---|
| PostgreSQL 不可达 | 请求失败且不泄漏，连接恢复后进程可继续服务 |
| Qdrant 不可达 | Retrieve/Ask fail closed；不得返回无依据答案 |
| Worker 停止 | 新任务保持 queued；恢复后通过确定性 workflow id 继续 |
| Parser 失败 | 任务可诊断、可重试；替换任务不得覆盖旧 active |
| 模型失败 | 返回明确服务错误或拒答；不得伪造引用 |

## 备份与灾难恢复

```bash
cd deploy/compose
./scripts/backup.sh ./backups/<backup-id>
CONFIRM=YES ./scripts/restore.sh ./backups/<backup-id>
```

备份必须包含 PostgreSQL、DBOS、文档对象、Qdrant 和 manifest 校验值。恢复只允许在维护窗口
或可丢弃环境执行，顺序见 [DEPLOYMENT.md](./DEPLOYMENT.md)。每个目标环境都要实际恢复一次，
并记录 RPO、RTO、数据对照值和恢复后的隔离检查。

以下任一情况表示恢复失败：active pointer 与可见 generation 不一致、引用指向不存在版本、
对象缺失、跨租户数据出现，或必须手工改库才能恢复。

## CI 与镜像发布

| Workflow | 责任 |
|---|---|
| `.github/workflows/ci.yml` | Web/TS 测试、评分器、类型、Lint、迁移与四镜像构建 |
| `.github/workflows/release-images.yml` | ACR/GHCR 推送、Trivy HIGH/CRITICAL 门禁和 digest manifest |

本地候选镜像：

```bash
just check
just images v0.1.0
just release v0.1.0 REGISTRY/NAMESPACE
```

manifest 记录四个镜像 digest 和 DBOS application version。升级只能引用该不可变 manifest；
扫描失败不得发布。SBOM、签名和 provenance 目前不是通用交付能力，客户合同要求时必须在
该项目的发布门禁中补齐。

## 事故记录

事故记录至少包括版本/digest、环境、时间线、影响范围、关联 ID、是否存在权限或引用错误、
处置动作、恢复验证和后续测试。任何跨租户泄漏、错误 generation 召回或无证据回答都应按
发布熔断级事件处理。

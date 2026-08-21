# UnoRAG 发布与验收

UnoRAG 的发布结论必须绑定明确的 commit、四个镜像 digest、配置摘要和目标环境。历史 PASS
不能自动传递给新代码、新模型、新 ParserProvider 或另一个客户环境。

## 发布层级

| 层级 | 含义 |
|---|---|
| Code green | 确定性测试、类型、Lint、迁移和构建通过 |
| Release candidate | 不可变镜像已发布，真实文件与完整产品链路通过 |
| Pilot GO | 候选版本在受控试点环境通过安全、可靠性和质量门禁 |
| Production GO | 在目标客户环境完成容量、恢复、监控、身份和责任签字 |

当前仓库具备 TS-only RC / 受控试点基线，不代表对任意客户环境无条件 production-ready。
当前证据见 [`evidence/`](./evidence/)。

## 1. 确定性门禁

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm test:ts-core
# CI 或隔离基础设施中运行，必须 0 skip
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm audit:prod
pnpm db:check
NEXT_TELEMETRY_DISABLED=1 pnpm build
```

生产依赖审计固定使用 npm 官方 advisory 端点，并以 `moderate` 及以上为失败门槛；本机 npm 镜像
不提供审计接口时，不得把工具错误记录为通过。

再验证部署产物：

```bash
source deploy/compose/scripts/compose-env.sh
mk_compose config >/tmp/unorag-compose.yml
helm lint deploy/helm/unorag --set config.openaiBaseUrl=http://llm
git diff --check
```

普通本地测试中的环境依赖用例可以 skip，但 CI 的 `test:integration` 必须在临时 PostgreSQL、Qdrant、
Redis 上 0 skip 通过；候选版本还必须在完整 Compose 环境中补齐产品纵向验收。

## 2. 建立不可变候选版本

记录：

- Git commit 与分支；
- `web`、`migrator`、`ops`、`worker` 镜像 digest；
- manifest 中声明的产品镜像平台与目标 Docker/Kubernetes 节点架构；
- DBOS application version；
- Compose overlay 或 Helm values 摘要；
- 模型、Embedding、Rerank、ParserProvider 名称及版本；
- 数据库、Qdrant 和宿主机规格；
- 测试数据集版本。

Trivy HIGH/CRITICAL 门禁失败、缺失 BuildKit SBOM/provenance、使用浮动镜像标签或无法复现配置时，
不得进入试点验收。镜像签名门禁落地前，发行材料必须明确标记为未签名 RC。
官方 `v0.1` manifest 必须包含 `UNORAG_IMAGE_PLATFORM=linux/amd64`。安装和升级前的架构预检失败
属于 NO-GO；`--allow-platform-emulation` 只供开发机 RC 验证，不能用于客户生产签字。
官方 manifest 将 DBOS application version 固定为 `unorag-<git-sha>`。它是 durable workflow 的代码
兼容边界，不是可手改的营销版本；不同代码提交不得复用同一值，同一发布的 Web/control/worker 必须
使用同一值。

### 版本契约

`package.json` 的 `version` 是产品基础版本的唯一事实源。正式镜像构建时，release workflow 通过构建
参数写入以下不可变元数据，运行时不得从数据库或浮动 tag 推断版本：

| 字段 | 含义 | 示例 |
|---|---|---|
| `UNORAG_VERSION` | 用户可见产品版本；Git tag 去掉前导 `v` | `0.1.0-rc.9` |
| `UNORAG_REVISION` | 构建对应的完整 Git commit | 40 位 SHA |
| `UNORAG_BUILD_TIME` | 镜像构建时间 | ISO 8601 UTC |
| `UNORAG_DBOS_APPLICATION_VERSION` | durable workflow 兼容边界 | `unorag-<git-sha>` |
| `UNORAG_IMAGE_DIGEST` / `UNORAG_BUILD_REF` | 实际运行镜像身份 | `sha256:<digest>` |

`GET /api/rag/health/ready` 返回 `release` 对象；管理员设置页和运维看板显示相同信息。验收必须确认
接口中的 version、revision、digest 与发布 manifest 一致。开发构建统一显示
`<package-version>-dev[+revision]`，不能伪装成正式 RC。

全新客户环境必须直接消费该 manifest，不能在目标机重新构建源码：

```bash
cd deploy/compose
./scripts/install.sh --manifest /path/to/release-acr.env
```

## 3. 真实纵向验收

```bash
./deploy/compose/scripts/pilot-preflight.sh
cd deploy/compose
./scripts/pilot-smoke.sh
source scripts/compose-env.sh
mk_compose --profile ops run --rm inspect-lifecycle
```

脚本退出码：`0` 通过，`1` 失败，`2` 因环境或外部依赖阻塞。`2` 不能记录为 PASS。

真实文件至少覆盖 Markdown、DOCX、文字 PDF；声明支持 OCR 或复杂 PDF 时，加入扫描件、
跨页表和代表性布局。每份文件记录格式、页数、预期事实和预期引用。

| 操作 | 验收要求 |
|---|---|
| 创建与切换 Workspace | 数据互不可见，当前 Session 与 Service Key scope 正确 |
| 上传 | 返回异步 job，最终 document 为 ready |
| Retrieve/Ask | 命中正确文档，回答包含可定位 citation |
| 替换 | 处理期间旧版可用，成功后原子切换 |
| 失败替换 | 旧 active 继续服务 |
| 重试/取消/删除 | 幂等，完成后旧内容不可召回 |
| Viewer 操作 | 读权限符合策略，所有写操作被拒绝 |
| 归档与续聊 | 归档可恢复，追问 rewrite 不扩大访问范围 |

开发诊断可运行 `pnpm eval:live`；正式 RC 必须运行 `pnpm eval:stability`。它先对一轮真实文件入库
执行可靠性门禁，再在同一不可变知识库上连续运行三轮 Ask，记录正例、拒答、事实覆盖、Recall、MRR、
citation coverage、延迟和构建指纹。流程、凭据和可选 Langfuse 分数发布见
[EVALUATION.md](./EVALUATION.md)。
Parser、模型、切分、检索或裁决策略变化后必须重跑，不能继承旧分数。

## 4. 安全熔断

以下项目要求零失败：

- 跨 organization、workspace、principal 或 group 泄漏；
- IDOR 获取无权文库、文档、任务、归档或调试信息；
- 未激活、已替换或已删除 generation 被召回；
- 无资料问题未拒答；
- citation 无法支持答案；
- 表格执行缺少全部贡献行证据。
- 确定性表格结果经生成模型转述后遗漏行、边界值，或截断却未明确披露。

隔离自动化入口：

```bash
./scripts/acceptance/s1_s2_isolation.sh
```

任一安全熔断失败都直接判定 NO-GO，不能用平均质量分抵消。

## 5. 故障、升级与恢复

候选版本必须验证：

- PostgreSQL、Qdrant、Worker、模型和 ParserProvider 的停止与恢复；
- submit/poll 重启不会重复计费、重复激活或产生不可恢复任务；
- 替换失败继续服务旧 active；
- digest-pinned 升级和应用镜像回滚；
- DBOS version 变化时入口先关闭，旧业务任务与旧 workflow 均排空；活动任务存在时升级必须等待或
  超时拒绝，不能把旧任务留给新版本 Worker；
- PostgreSQL、DBOS、文档对象与 Qdrant 的破坏性恢复演练；
- 恢复后 Ask、引用、上传、删除和跨 Workspace 隔离。

发布结束时 `dead=0`、`stuck=0`、pending ACL 为 0。无法自动恢复且需要手工改库的流程不得放行。

## 6. 目标环境生产清单

### 正确性与安全

- [ ] active version / generation / citation 一致
- [ ] 替换、重试、取消和删除幂等
- [ ] 跨组织、Workspace、组和用户零泄漏
- [ ] Viewer 写操作被拒绝
- [ ] Web/Worker 使用最小权限数据库角色
- [ ] 只有 Next.js 产品边界对外开放

### 可靠性与交付

- [ ] 四镜像 digest、CVE 结果和配置摘要已归档
- [ ] manifest 镜像平台与目标节点架构一致，未使用生产模拟运行
- [ ] manifest 的 DBOS application version 与 Git commit 一致，排空/拒绝升级演练通过
- [ ] 全新安装、升级、应用回滚、备份恢复均通过
- [ ] 目标硬件容量、P50/P95、并发预算、RPO/RTO 已记录
- [ ] lifecycle 巡检、Provider 错误、磁盘和依赖故障均有告警负责人
- [ ] 客户数据库、模型、Parser、存储和密钥边界已确认
- [ ] 已知限制、SLA/SLO 和升级路径随版本交付

OIDC、S3、HPA/PDB/NetworkPolicy、SBOM/签名等功能若由客户合同或安全基线要求，就自动成为
该次交付的必选门禁；不能因为它们在通用路线中后置而豁免。

## 7. Go / No-Go 记录

```text
版本 / commit:
四镜像 digest:
部署环境与配置摘要:
模型与 ParserProvider:
真实文件与质量结果:
隔离熔断:
故障、升级、恢复:
容量与监控责任:
已知限制:
结论: GO | CONDITIONAL GO | NO-GO
签署人 / 日期:
```

只有结论明确为 GO，且上述项目都有可访问证据时，才允许对该版本和目标环境使用
“production-ready”表述。

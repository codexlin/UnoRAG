# TypeScript RC 4829e41 全量复验

- 日期：2026-08-04（Asia/Shanghai）
- 分支：`refactor/ts-core-runtime`
- 提交：`4829e41b904f0d677488bc5e7c6a6178f9a1217b`
- 平台：Apple Silicon 宿主机上的 `linux/amd64` 候选镜像
- 结论：**本地 RC 工程、质量、升级与恢复门禁 PASS；镜像尚未推送 registry，不构成客户生产发布物**

## 1. 版本与供应链

本轮从同一提交构建 `web`、`migrator`、`ops`、`worker` 四个目标，均以非 root `unorag`
用户运行。Trivy 0.70.0 使用 `--ignore-unfixed --severity HIGH,CRITICAL --exit-code 1`
扫描，四个镜像均为 0 HIGH / 0 CRITICAL。

| 镜像 | 本地引用 | manifest digest |
|---|---|---|
| Web | `unorag-web:rc-4829e41` | `sha256:46025d1c08930e08cf1201e2a81675cfbd776b9df9649279ed91beb469ddc52c` |
| Migrator | `unorag-web-migrator:rc-4829e41` | `sha256:4bd3faac4b6d66ebaef8ed0236793ac26dc66fc4ca72ccc8a94f3ea9ad35df29` |
| Ops | `unorag-web-ops:rc-4829e41` | `sha256:d938ed85496139177ef9594a9c0fbb6d24e7284e5d19352d07ec3fc609db60d0` |
| Worker | `unorag-web-worker:rc-4829e41` | `sha256:7bb69b5b916400de57fa114d2c6cb6de63e61d5f47aa6f168519ec62b915a6ed` |

这些 digest 是本地 OCI manifest 标识。客户升级仍须使用发布 workflow 推送后生成的 registry
digest manifest，不应复制本地 tag 作为生产版本引用。

## 2. 自动化与真实依赖

| 门禁 | 结果 |
|---|---:|
| Web 确定性测试 | 161 pass / 1 environment skip / 0 fail |
| TS Core 确定性测试 | 228 pass / 12 environment skips / 0 fail |
| 真实 PostgreSQL/Qdrant Web 套件 | 162/162 PASS |
| 真实 PostgreSQL/Qdrant TS Core 套件 | 239/239 PASS |
| TypeScript、Biome、Drizzle、Next production build | PASS |
| Compose config、Helm lint/template、shell syntax | PASS |

最终路由修复只改变 Ask Query Router；修复后重新运行了完整确定性套件和真实 AB。真实数据库
零 skip 套件已在同一依赖与镜像变更集上完成。该分支 push 不触发只监听 PR/main 的 GitHub CI，
因此本报告记录的是本地门禁，不冒充远端 workflow 结果。

## 3. 安装、升级与产品链路

- 从空卷安装 PostgreSQL 17、Qdrant 1.13.2、Redis 7、Web、DBOS worker/control 与 Caddy：PASS。
- migration、最小权限运行角色、bootstrap organization/workspace/admin、ACL backfill：PASS。
- 从 `rc-c582f2e` 原地升级到 `rc-4829e41`：PASS；数据卷保留、迁移与角色配置可重入。
- Pilot smoke：上传、DBOS 入库、Retrieve/Ask、Service Key scope、跨文库隔离、替换与删除：PASS。
- 真实浏览器：管理员登录、创建知识库、设置页、390x844 响应式布局：PASS；无控制台错误或横向溢出。

## 4. 真实文件与质量

7/7 代表性真实文件重新入库成功，覆盖长 DOCX、跨页大表 PDF、图表 PDF、80 行报价 DOCX、
5K 叙事 Markdown、低对比扫描 PDF 与双栏 PDF。

| 指标 | 结果 |
|---|---:|
| 正例黄金集 | 33/33 |
| 拒答集 | 5/5 |
| Document Recall@K | 1.0 |
| Document MRR | 0.9798 |
| Ask latency P50 | 7.80s |
| Ask latency P95 | 13.32s |
| Ask latency max | 15.53s |

本轮发现一个完整复合问题被模型路由为 `ambiguous`。修复后，自包含且带有“根据、规定、要求、
提到、中、里”等检索线索的问题会确定性进入 fact 路径；真正缺少上下文的短问句仍进入澄清。

## 5. 故障恢复与最终状态

| 场景 | 结果 | 证据 |
|---|---:|---|
| Qdrant 停止/恢复 | PASS | 停止时 `degraded=true`、`qdrant_ok=false`、`ask_ready=false`；恢复后全就绪 |
| DBOS worker 停止/恢复 | PASS | 上传任务保持 `queued`，worker 恢复后自动 `completed` |
| PostgreSQL 停止/恢复 | PASS | 停止时 HTTP 503、`metadata_ok=false`；恢复后 HTTP 200 与全就绪 |
| 生命周期巡检 | PASS | dead=0、stuck=0、cleanup error=0、pending ACL=0 |

Qdrant 不可用时健康端点仍可能返回 HTTP 200，因为 Web/metadata 仍可服务；运维探针必须读取
`ask_ready` 和 `degraded`，不能仅以 HTTP 200 判定完整业务就绪。

一次性验收 Compose project、容器和数据卷已删除，Git 工作区在测试结束时保持 clean。

## 6. 发布判定

**GO for local RC validation；NO-GO for direct customer production promotion。**

进入客户部署前仍需推送四个镜像，归档 registry digest manifest，在目标环境执行备份/恢复、
容量与并发、身份 Provider、模型与 ParserProvider、告警责任和签字型 go/no-go。当前最明显的性能
预算项是 Ask P95 13.32s，应在客户模型、网络和并发配置下重新测量并制定 SLO。

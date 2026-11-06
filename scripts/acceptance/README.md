# UnoRAG 验收自动化

生命周期与发布脚本通过产品 HTTP 边界测试原生 TypeScript 运行时；本地解析镜像冒烟
直接调用 ParserProvider，并在断网容器中验证原生依赖。Python FastAPI 时代的
恢复、升级、故障注入与 OCR 脚本已经退役。当前证据保存在 `docs/evidence/`，
但不能用于证明后续提交。

## 当前入口

| 脚本 | 覆盖 |
|---|---|
| `deploy/compose/scripts/pilot-preflight.sh` | TS core、Web 契约、类型与迁移静态门禁 |
| `deploy/compose/scripts/pilot-smoke.sh` | 登录、上传、Ask、Public API、replace、delete 全链路 |
| `scripts/acceptance/s1_s2_isolation.sh` | 多组织、多 Workspace、ACL 与 IDOR 零泄漏 |
| `scripts/acceptance/capacity_baseline.py` | Retrieve、Ask、生命周期阶梯并发与可选 MinerU 探针 |
| `scripts/acceptance/business-matrix.mjs` | 同库混合文档、相似制度干扰、原文摘要、问答/拒答、版本生命周期与请求诊断；不修改既有库或注入全局故障 |
| `scripts/acceptance/evidence-conflicts.ts` | 固定证据的冲突/非冲突 judge 对照；真实模型调用，不是端到端检索验收 |
| `scripts/acceptance/upgrade-rollback.mjs` | 四镜像 digest 升级、旧版应用回滚、再次升级与数据校验 |
| `scripts/acceptance/provider-faults.mjs` | 真实 Provider 透传基线、受控故障注入、失败替换保留旧版与恢复 |
| `scripts/acceptance/restore-drill.mjs` | 隔离实例备份、删卷、恢复、Ask 与生命周期校验 |
| `scripts/acceptance/release-gate.mjs` | 按绑定 commit / manifest 的 profile 串行执行发布门禁 |
| `scripts/acceptance/local-parser-smoke.ts` | Worker 镜像断网、只读条件下的真实文字 PDF 与扫描件 OCR；保留低置信度警告，不等于 OCR 质量全通过 |

所有验收脚本使用一致退出码：`0` 通过，`1` 失败，`2` 因依赖或配置缺失而
阻塞。`2` 不能记为产品通过。

S1/S2 使用固定的测试组织和 Workspace，只能用于一次性隔离环境，不能指向客户或共享数据。
默认在成功、失败、阻塞或可捕获的中断退出时，通过产品 API 删除测试知识库，等待 PG 中的文档、任务和
generation 清理终态，再级联移除拓扑。清理失败会保留拓扑并令最终结果 FAIL；报告的 `cleanup` 字段
区分 `passed`、`failed`、`not_needed` 和显式保留的 `kept`，不能把 `kept` 当作清理通过。
`UNORAG_ISOLATION_KEEP=1` 可保留现场；排障后使用相同连接与密码运行
`node scripts/acceptance/bootstrap_isolation_topology.mjs --cleanup`，该入口同样先走产品删除流程。
执行中的报告为 `RUNNING`；可捕获的 INT/TERM 中断最终记为 FAIL，退出码沿用 `130` / `143`。
强制断电或 SIGKILL 无法触发 EXIT trap，恢复后仍须执行该命令；不要为清理扩大 COS Bucket 权限。

## 推荐顺序

```bash
./deploy/compose/scripts/pilot-preflight.sh
./deploy/compose/scripts/pilot-smoke.sh
./scripts/acceptance/s1_s2_isolation.sh

UNORAG_BASE_URL=https://example.internal \
UNORAG_ADMIN_EMAIL=admin@example.com \
UNORAG_ADMIN_PASSWORD='...' \
  python3 ./scripts/acceptance/capacity_baseline.py
```

容量结果只绑定测试环境、资源规格、模型 Provider、语料和 commit，不可直接外推。
使用 `--mineru-file testdata/ab/twocolumn.pdf` 可加入真实复杂 PDF 探针。

## 混合业务矩阵

先审查 `testdata/business/scenarios.json` 和计划。此脚本需要本仓库已安装的 Node.js 22/tsx 依赖，
不是安装机裸 Node 的独立命令。凭据由受保护环境注入，不写进命令历史或提交文件。

```bash
node --import tsx scripts/acceptance/business-matrix.mjs --plan

UNORAG_ACCEPT_BUSINESS_MATRIX=YES \
UNORAG_BASE_URL=https://candidate.example.com \
UNORAG_EXPECT_REVISION='<expected-40-character-runtime-revision>' \
node --import tsx scripts/acceptance/business-matrix.mjs
```

还需提供 `UNORAG_ADMIN_EMAIL` / `UNORAG_ADMIN_PASSWORD`。只向脚本新建、随机 run ID 命名的库写入；
默认最后删除这些库。`--keep-library` 只保留混合语料库供浏览器核对，不能把保留状态记成清理通过。
`.unorag/acceptance/` 的受限报告包含 own-library ID、来源标注、SHA256、任务、参考答案、回答、引用和
Request ID；不要把这些原始产物直接公开。强制终止可能留下测试库，按报告中的确切 ID 经产品 API 清理，
不要按模糊前缀批量删除。测试不停止生产依赖、不修改模型配置，也不自动修复业务代码。

问答先复用现有确定性评分器，既不自动接受新增引用来源，也不把模型故障算成正常拒答。
失败必须结合原文与请求阶段人工归因，区分资料冲突、预期不足、解析、检索、裁决和生成错误；
不为通过测试反向修改预期。P95 仍以 15 秒单独判定，但一个业务探索批次不是三轮稳定性认证。

## 证据冲突对照

修改证据裁决时，先用合成对照检查误报，再跑完整业务矩阵。沿用 `OPENAI_*` / `JUDGE_*` Provider 配置，
凭据仅从受保护环境注入；默认计划不联网，执行必须显式同意出域和付费调用：

```bash
node --import tsx scripts/acceptance/evidence-conflicts.ts --plan
UNORAG_ACCEPT_JUDGE_CONTROLS=YES node --import tsx scripts/acceptance/evidence-conflicts.ts --allow-external-judge
```

此入口仅调用独立冲突核验器，不调用普通充分性 Judge，不代表完整问答 pipeline。默认两轮、每轮八个
合成案例、每次至多两次请求/15 秒单次超时/1024 输出 Token，串行执行。
`--rounds=1..3` 可调整轮数；分类错误、结构化失败或摘录来源校验失败均保留为 FAIL，不能靠重跑覆盖。
报告保存在 `.unorag/acceptance/`，固定证据通过不证明检索完整，也不能代替逐条语义复核或发布验收。

## 发布演练与边界

升级回滚、Provider 故障和隔离恢复已有自动化入口，具体参数、显式授权开关及完整 profile 见
[RELEASE.md](../../docs/RELEASE.md)。先使用 `--plan` 检查目标，再在独立实例执行；不得在生产实例
运行破坏性恢复。脚本已有不代表新候选自动通过，必须保留本次运行的版本、环境与结果。

Provider 故障脚本使用可控代理注入 HTTP 状态和超时，先后验证真实上游透传与恢复；它不等于对
外部托管模型或 MinerU 服务执行真实重启。Worker / 数据服务停启仍需按部署环境另外演练。

本地对象存储的恢复演练包含文档备份；COS 模式只备份数据库、Qdrant 和对象存储边界说明，远端对象
仍留在原桶中，不能据此声称已经验证对象误删或桶级灾难恢复。客户容量、对象备份策略和 RPO/RTO
仍须分别验收并归档。

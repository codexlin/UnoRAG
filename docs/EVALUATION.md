# 质量评测与 Prompt 生命周期

UnoRAG 使用 **repository-first** 评测：版本化黄金集、确定性评分器、Prompt 和发布门禁都在仓库中，
Langfuse 是可选的实验与分数视图，不是生产 Ask 的配置中心或可用性依赖。

## 事实源

| 内容 | 事实源 | 说明 |
|---|---|---|
| 正例黄金集 | `testdata/ab/golds.jsonl` | 33 条真实文件问题、原子事实和目标文件 |
| 拒答黄金集 | `testdata/ab/negative-golds.jsonl` | 5 条资料未覆盖问题 |
| Prompt | `src/core/ai/prompt-registry.ts` | 名称、语义版本、正文与 SHA-256 digest |
| 评分逻辑 | `src/evaluation/` | 中文数字/单位归一化、事实覆盖、Citation、拒答和门禁 |
| Live runner | `scripts/run-ab-live-e2e.ts` | 真实上传、入库、Ask、报告与可选分数发布 |

不要在 Langfuse 中维护另一份独立黄金集作为发布门禁。否则代码评测与平台评测会随时间漂移，CI 无法
证明线上版本使用了哪一份数据。

## Prompt 变更流程

五类生产 Prompt 统一登记为 `chat`、`router`、`rewrite`、`judge` 和 `table_plan`。修改正文时必须：

1. 在 `prompt-registry.ts` 更新正文并提升语义版本；
2. 更新 Registry 测试锁定的 digest；
3. 运行 TypeScript 单元测试和 live evaluation；
4. 比较事实覆盖、文档 Recall/MRR、拒答准确率和延迟；
5. 门禁通过后随代码评审、提交和发布进入生产。

运行时 Span 只记录 Prompt 名称、仓库版本和 digest，不记录 Prompt 正文。生产服务不会从 Langfuse
动态拉取 `production` 标签，因此 Langfuse 故障或误操作不能即时改变客户回答。需要试验 Langfuse
Prompt 时，应先在隔离分支/环境导出候选内容，再按上述流程固化回仓库。

## 本地契约测试

```bash
pnpm exec tsx --test --test-concurrency=1 \
  tests/ts-core/evaluation-*.test.ts \
  tests/ts-core/prompt-registry.test.ts
```

这些测试不调用模型或外部平台，负责锁定黄金集 schema、中文数字等价、边界值、分数 payload 隐私、
Prompt 身份和 CLI 配置。

## 真实 Live Evaluation

先启动完整 UnoRAG 环境并准备管理员凭据：

```bash
export UNORAG_BASE_URL=http://127.0.0.1:3000
export UNORAG_ADMIN_EMAIL=admin@example.com
export UNORAG_ADMIN_PASSWORD='replace-me'
pnpm eval:live
```

也可通过权限为 `0600` 的 `UNORAG_AB_PASSWORD_FILE` 读取密码，避免进入 shell history。远程 UnoRAG
与 Langfuse 地址必须使用 HTTPS；只有 `localhost`、`127.0.0.1` 和 `::1` 允许 HTTP。Runner 会：

1. 检查健康并登录；
2. 创建临时知识库并上传 7 份代表性真实文件；
3. 等待每个 DBOS 入库任务终态；
4. 执行 33 条正例和 5 条拒答用例；
5. 写入 `testdata/ab/_e2e_out/ab_live_*.json|md`；
6. 默认发起删除并轮询临时知识库消失，`--keep-library` 可保留现场。

入库失败不会被跳过：对应正例直接按失败计入分母，防止产生虚高通过率。

默认发布门禁：

| 指标 | 阈值 |
|---|---:|
| 正例通过率 | 100% |
| 平均原子事实覆盖 | 100% |
| 目标文档 Recall@K | 100% |
| 拒答准确率 | 100% |

每条正例必须包含目标文档 Citation，且该目标文档必须提供黄金集声明的内容模态；平均分不能抵消单题
无 Citation 或类型错误。黄金集的 `text` 模态兼容运行时 `text`、`chunk`、`section`，`table` 兼容
`table`、`table_summary`，`image` 必须由 `image` Citation 支撑。原子事实覆盖是带数字、单位、边界和
显式否定保护的确定性词法门禁，不宣称替代语义正确性或人工复核。

门禁失败时命令退出码为 `1`；配置、清理或显式发布失败为 `2`。报告同时保留 MRR、跨文档 Citation 比例及
P50/P95/最大延迟，当前不把延迟固定成跨硬件统一阈值。

本地 JSON 报告包含问题、回答和参考事实，应视为敏感测试产物。Runner 将输出目录设为 `0700`、文件
设为 `0600`；报告目录已被 Git 忽略，操作者应按客户数据保留策略定期删除。

## 可选 Langfuse 分数发布

只有操作者显式执行以下命令时才发布：

```bash
export LANGFUSE_BASE_URL=https://langfuse.example.com
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
pnpm eval:live -- --publish-langfuse-scores
```

这组项目 API Key 只存在于评测进程环境，不写入 `runtime.secret`，也不进入 Web/Worker/Collector。
它与 Collector 使用的 `LANGFUSE_OTLP_AUTHORIZATION` 是两条不同权限链。

Publisher 使用官方 `@langfuse/client`，按每个评测 Session 写入：

- `unorag.eval.pass`；
- `unorag.eval.fact_coverage`；
- `unorag.eval.document_recalled`；
- `unorag.eval.refusal_correct`。

发送内容仅包含 Session ID、哈希 case ID、run ID、release 和数值/布尔分数；不会发送问题、模型回答、
参考答案、关键事实或 Citation 正文。Langfuse 发布失败不会改写报告中的本地门禁结论，但显式要求发布
时命令会返回退出码 `2`，避免 CI 把未完成的发布动作记为成功。
当前没有自动同步 Langfuse Dataset；未来若增加，必须使用独立显式命令并确认测试数据允许出域。

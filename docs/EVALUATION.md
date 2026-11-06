# 质量评测与 Prompt 生命周期

UnoRAG 使用 **repository-first** 评测：版本化黄金集、确定性评分器、Prompt 和发布门禁都在仓库中，
Langfuse 是可选的实验与分数视图，不是生产 Ask 的配置中心或可用性依赖。

## 事实源

| 内容 | 事实源 | 说明 |
|---|---|---|
| 正例黄金集 | `testdata/ab/golds.jsonl` | 36 条真实文件问题、原子事实、目标文件和专项质量维度 |
| 拒答黄金集 | `testdata/ab/negative-golds.jsonl` | 5 条资料未覆盖问题 |
| Prompt | `src/core/ai/prompt-registry.ts` | 名称、语义版本、正文与 SHA-256 digest |
| 评分逻辑 | `src/evaluation/` | 中文数字/单位归一化、事实覆盖、Citation、拒答和门禁 |
| Live runner | `scripts/run-ab-live-e2e.ts` | 真实上传、入库、Ask、报告与可选分数发布 |
| Stability runner | `scripts/run-ab-stability.ts` | 连续三轮真实评测、逐题稳定性与 RC 发布门禁 |
| 离线语义评测 | `scripts/evaluation/` | 可选 Ragas、独立 Python 锁文件、受控输入与预算；不进入产品镜像 |

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
2. 创建临时知识库并上传主文件与显式辅助文件的去重并集（当前 7 份真实文件）；
3. 等待每个 DBOS 入库任务终态；
4. 执行 36 条正例和 5 条拒答用例；
5. 写入 `testdata/ab/_e2e_out/ab_live_*.json|md`；
6. 默认发起删除并轮询临时知识库消失，`--keep-library` 可保留现场。

入库失败不会被跳过：对应正例直接按失败计入分母，防止产生虚高通过率。

默认发布门禁：

| 指标 | 阈值 |
|---|---:|
| 正例通过率 | 100% |
| 平均原子事实覆盖 | 100% |
| 目标文档 Recall@K | 100% |
| Citation precision | 100% |
| 拒答准确率 | 100% |

默认每条正例只能引用目标文档。个别用例可显式声明 `supporting_sources`，但不能全局放行其它文档：

```json
"supporting_sources": [
  {"file": "mixed-charts.pdf", "key_facts": ["375,000,000"], "expect_record_type": "text"}
]
```

每个辅助来源必须指定非空的 `key_facts` 子集和记录类型。每个用例最多 8 个辅助来源、64 个事实，每个事实
最多 512 字符，文件名最多 255 字符。主、辅文件只能是 fixture basename，不能包含路径、
盘符或控制字符；重复文件（包括把主文件列为辅助）、重复事实、未知字段或不属于用例的事实均拒绝。
启用多来源时主文件也必须声明记录类型。没有新增字段的旧用例继续使用原规则；case ID 仍只由主文件与
问题计算，新增辅助声明不改变历史 ID。

多来源用例仍必须引用原主文件，答案仍必须覆盖全部 `key_facts`。每条主文件引用需匹配主记录类型并在正文
中支持至少一个事实；每条辅助引用需匹配自己的类型，并在该条正文中支持它声明的全部事实。辅助引用只能为
声明的事实贡献覆盖，不能凭其它正文替代未授权事实；所有有效引用的正文合并后也必须覆盖完整事实集。
缺少正文、无关引用、错误预算（如仅出现 3.9 亿元）或显式否定导致事实不匹配、类型错误或主文件缺失都会失败。辅助来源是可选引用，
不是强制必须引用，也不是同名文件的无条件白名单。已知用例 `0a75cfac32601f6b` 的主文件仍为
`report-narrative-5k.md`；`mixed-charts.pdf` 仅获准支持投资 `375,000,000`，不能支持 `二十四个月`。

平均分不能抵消单题缺事实、无 Citation、无效跨文档 Citation 或类型错误。黄金集的 `text` 模态兼容运行时 `text`、`chunk`、`section`，`table` 兼容
`table`、`table_summary`，`image` 由规范化的 `figure` Citation 支撑（兼容历史 `image` 值）。原子事实覆盖是带数字、单位、边界和
显式否定保护的确定性词法门禁，不宣称替代语义正确性或人工复核。
引用正文核验也不是语义蕴含判断：同一引用同时提及正确值和矛盾候选值、其它上下文中的相同数字，或复杂
否定表达，仍可能通过词法匹配。它不提供普适冲突检测，不能据此宣称所有引用均语义正确。

现有 `documentRecallAtK` 和 MRR 根据**最终 Citation**中的目标文档出现与排序计算，不是完整候选集上的
标准检索 Recall/MRR。`123/123` 等结果只表示当次确定性契约通过，不能解释为语义正确率或忠实性满分。

拒答用例中的 `judge_unavailable` 是操作故障，不是正确的资料不足拒答；即使 HTTP 200 且 `refused=true`
也按失败计算。稳定性门禁继续把 `judge_mode=model_error` 记为 Judge 故障，不改变 API 兼容映射。

黄金集还通过 `quality_dimensions` 把复杂能力从总体分数中拆开。目前发布必须同时满足：

| 专项维度 | 用例 | 独立门禁 |
|---|---:|---|
| `cross_page_table` | 6 | 单题通过、事实覆盖、目标文档召回、Citation precision 和记录类型均为 100% |
| `low_contrast_scan` | 5 | 单题通过、事实覆盖、目标文档召回、Citation precision 和记录类型均为 100% |

跨页表用例覆盖第 1→2 页和第 2→3 页边界、明细全表比较与汇总冲突；低对比扫描用例覆盖两页 OCR、
编号、金额、百分比和跨页事实组合。若某个必需维度被意外从黄金集删除，发布同样失败，而不是把它当作
零样本通过。

Ask 将检索与最终证据分成三层：Retriever/Reranker 先产生候选证据，Judge 再从候选 ID 中选择能够
完整支持回答的最小集合，最后只从本次已召回且同文档、同版本的记录中补齐结构化来源关系。来源补齐
覆盖原始 `table`、`table_summary` 与 `figure`，必须通过 `table_id`、`figure_id`、source chunk 或
source node 关系匹配，不会发起隐藏检索，也不会跨文档扩张 Citation。Judge 返回空 ID、虚构 ID 或
越界 ID 时 Ask fail closed，不生成无依据答案。

另有一条显式的确定性查表入口：普通召回含真实 `table_id` 时，可通过同一授权检索边界探测
原始表格记录；该探测计入 `retrieve` 阶段，不是上述来源补齐。只有单实体能够对应实际单元格、
且问题明确提到输出列时，才升级为原有结构化查表执行；不会按文件名或黄金集问题特判。
聚合、占比、排名、汇总说明和歧义问题不由该入口抢占，无法建立计划时保留原始证据与 Judge 流程。
Markdown 管道表目前可能仍是普通文本，不保证生成 TableIR，也不保证进入该入口。
相关性阈值使用 rerank 分数；未重排的混合检索使用 dense 分数，不能拿 RRF 排名分直接与
相关性阈值比较。缺少 dense 证据的纯词法候选不会因此绕过阈值。

报告中的 `evidence candidates / selected` 分别表示进入 Judge 的候选数与最终 Citation 数；
`evidence selection rate` 是二者之比。`citation precision` 衡量主来源与经核验辅助来源占最终 Citation 的比例。
`crossDocumentCitationRate` 保留所有非主文件引用（包括合法辅助引用）的真实比例；
`supportingCitationRate` 单列合法辅助比例，`invalidCrossDocumentCitationRate` 单列无效跨文档比例，
`invalidCitationRate` 还包含多来源用例中不合格的主来源引用。专项质量门禁仍要求无效跨文档比例为零，
而不把合法辅助引用误作错误；所有通过率、事实覆盖、召回和 precision 阈值不变。这些指标用于识别“答案正确但证据过宽”，
同时类型门禁保证降噪不能丢掉表格或图表来源。

`inlineCitationsValid` 单独校验回答正文的数字引用：只允许引用本次 citations 中存在的独立
`[n]`，不允许把表格行号、区间或列表写作来源标记。该项失败直接使正例失败，不能被关键词命中
或结构化 Citation precision 抵消。运行时同样增量校验流式输出，非法标记不发送，记录
`answer_citation_invalid`，不持久化为成功回答；已经发出的文本可能作为失败尝试保留在页面。
历史未知引用只展示为原文，不渲染成合法来源按钮。数字字面量应使用代码格式；代码和普通
Markdown 链接不作为来源引用。这个校验只证明引用 ID 有效，不证明每个事实都被证据支持。

门禁失败时命令退出码为 `1`；配置、清理或显式发布失败为 `2`。报告同时保留 MRR、跨文档 Citation 比例及
P50/P95/最大延迟，当前不把延迟固定成跨硬件统一阈值。

新鲜入库还会生成 `provider_scorecard`：按实际 parser/provider 汇总文件数、完成/部分成功、失败页、警告、
解析 P50/P95，以及对应文件的问答通过率、事实覆盖、文档召回和 Citation precision。新鲜入库缺少可识别的
`parser_report`、存在失败页或非完成任务都会阻止发布；`partial` 和 warnings 会展示在
Provider scorecard 中供排查，但只有可确认的数据丢失才阻断发布。使用 `UNORAG_AB_LIBRARY_ID` 复用
已有知识库时，Provider 门禁明确标记为 `skipped_reused_library`；它只用于 Ask 调试，不能冒充解析验收。

Runner 内部评测 DTO 保留引用正文（优先 `body`，再 `text`、`snippet`）；登录态产品接口
`/api/rag/v1/ask` 已提供这些字段，无需修改映射或 Judge。Service Key 的公共 `/api/v1/ask` 仍不暴露完整
引用正文或内部 debug。本地 JSON 报告包含问题、回答、参考事实及引用正文，应视为敏感测试产物。Runner 将输出目录设为 `0700`、文件
设为 `0600`；报告目录已被 Git 忽略，操作者应按客户数据保留策略定期删除。

## 可选 Ragas 离线语义评测

Ragas 补充回答忠实性、回答相关性与检索质量，不替换权限隔离、版本、表格确定性计算、拒答或延迟门禁。
它不参与在线 Ask，不增加 Python 服务；Python 3.12 和 `uv` 只安装在操作者的离线评测环境。

```bash
uv sync --project scripts/evaluation --frozen
uv run --project scripts/evaluation --frozen python -m unittest discover -s scripts/evaluation/tests -v
uv run --project scripts/evaluation --frozen python scripts/evaluation/ragas_offline.py \
  scripts/evaluation/tests/fixtures/sample-v1.jsonl
```

最后一条命令默认**只校验，不调用模型，也不生成语义分数**。示例是合成数据，不是产品验收结果。
依赖版本由 `pyproject.toml` 与 `uv.lock` 固定；输入契约为 `sample-v1.schema.json`，与 TS 导出器保持一致。

### 采集真实 Ask 上下文

只在允许保存敏感测试数据的**隔离验收 Web 进程**显式开启，保持现有 DBOS、数据库、Parser 和模型配置：

```bash
UNORAG_EVAL_CAPTURE_SENSITIVE=1 \
UNORAG_EVAL_CAPTURE_RUN_ID=ragas-local-20261105 \
pnpm dev
```

另一终端按上文配置该环境的地址和管理员凭据，然后运行：

```bash
UNORAG_EVAL_CAPTURE_RUN_ID=ragas-local-20261105 pnpm eval:live -- --export-ragas
```

这两个采集变量默认关闭，不放进正式部署默认配置。Compose 不会因为宿主机 `export` 就自动注入它们，
容器验收时必须仅向隔离 Web 进程显式注入，并将其私有采集目录提供给离线导出器。
跨进程目录可通过 `UNORAG_EVAL_CAPTURE_INPUT_DIR` 指定；它必须是可信、受权限保护的测试产物。

导出器按 run/case/request/问题哈希关联数据，不拿最终引用或第二次 Retrieve 请求冒充原 Ask 的召回。
两组上下文分开保存：

- `retrieved_contexts`：最后一轮基础 Retriever 返回、尚未经策略/Judge 选择的有序候选，供检索指标使用。
  `full_retrieval` 只声明这一基础检索阶段完整，不涵盖所有表格执行器或其他工具内部查询。
- `generation_contexts`：生成器实际接收的证据文本（含标题、位置和表格结果）及本次授权历史，供忠实性使用。
  不能让被 Judge 丢弃的候选为生成答案提供“事后支持”。
- 生成流正常结束后记录响应 SHA-256，与 live report 的答案核对；流中断、缺失正文或写入失败不补造记录。
  构建指纹来自 live report，明确标为 `unverified`，不是服务端签名或独立部署证明。

未开启采集的旧报告仍可导出，但上下文为 `unavailable`，不能获得完整语义评测结论。确定性表格短路没有
模型生成上下文时，忠实性同样跳过，其正确性继续由原表格硬门禁验证。当前黄金集主要面向独立单轮问题；
多轮历史一致性不等于文档事实正确性，需单独人工校准，不宣称已完成多轮语义验收。

### 执行评分与解释结果

```bash
uv run --project scripts/evaluation --frozen python scripts/evaluation/ragas_offline.py \
  .unorag/evaluation/ragas-ragas-local-20261105.jsonl --max-samples=100
```

确认数据允许发送给评委模型后，再显式执行。以下以本地 OpenAI-compatible 服务为例：

```bash
uv run --project scripts/evaluation --frozen python scripts/evaluation/ragas_offline.py \
  .unorag/evaluation/ragas-ragas-local-20261105.jsonl \
  --execute --judge-base-url=http://127.0.0.1:11434/v1 \
  --judge-model=YOUR_JUDGE_MODEL --embedding-model=YOUR_EMBEDDING_MODEL \
  --max-samples=100 --max-requests=800 --max-input-bytes=10000000 --run-timeout=1800
```

外部评委必须额外设置评测进程的 `UNORAG_RAGAS_API_KEY`、使用 HTTPS 并增加 `--allow-external-judge`；
这不是修改产品模型配置，也不代表客户资料被默认允许出域。尽量使用独立评委并校准中文问题，避免同模型偏差。

| 指标 | 输入与边界 |
|---|---|
| Faithfulness | 使用实际生成上下文；人工提供的上下文明确标为 `provided` |
| Response relevance | 问题与回答；使用显式配置的评委和 Embedding 模型 |
| Context precision / recall | 需要完整基础检索候选与参考答案；不足则跳过，不用引用排名代替 |
| Context utilization | 没有参考答案时的候选利用诊断，不冒充有金标的 recall |
| Factual correctness（可选） | 回答与独立参考答案的双向事实比较；F1、高原子性、高覆盖率，不验证引用或权限 |

### 校准词面差异，而不是强迫模型复述

默认五项指标保持不变。用 `--metrics` 显式选择指标，可以只排查一种问题，减少模型请求和数据出域。
`factual_correctness` 使用锁定版本的 Ragas `FactualCorrectness`，不需要 Embedding 或召回上下文；
缺参考答案时跳过并标记不完整。报告记录所选指标、配置和工具指纹，`completed` 只代表所选诊断完成，
不代表未选择的指标、完整 RAG 链路或发布验收通过。
此指标本身不读取问题或引用原文，不能代替问答充分性或原文忠实性判断；参考答案遗漏的问题条件会使
正确回答被低估。`faithfulness` 仍是另一项需要生成上下文的诊断。

先验证仓库内合成校准集，不会调用模型：

```bash
uv run --project scripts/evaluation --frozen python scripts/evaluation/ragas_offline.py \
  scripts/evaluation/tests/fixtures/semantic-calibration-v1.jsonl --metrics factual_correctness
```

显式评分时增加 `--execute --judge-model=YOUR_JUDGE_MODEL` 和上文的评委地址/授权参数；
仅选此指标时不必提供 `--embedding-model`。十条校准样本包含正确原述、正确改写、漏答、否定、错误阶段、
无依据细节、回滚部分事实遗漏、正确/错误金额，以及简短参考答案对分数的影响。
相邻 `semantic-calibration-v1.expected.json` 固定了执行前预期区间；它们仅用于检查评委在这些反例上的
区分能力，**不是通用发布阈值**。参考答案要包含问题要求的主体、时间和否定条件，且能逐项追溯到原文；
不能看过分数后为答案量身改写参考答案。即使校准通过，也应抽样复核并考虑同模型偏差。

处理真实失败时保留原 report、manifest SHA、Case/Request ID 和原参考答案，另存离线诊断。
若对照补全了参考答案，应同时评分原参考与补全参考并记录依据，不覆盖原结果。最终引用不能冒充完整
召回或生成上下文；没有捕获时仍标为 `unavailable`，人工提供时标为 `provided`。

语义高分不能覆盖错误来源、非法引用、数值/单位、拒答、ACL 或延迟门禁；语义低分也不能直接定性产品有错。
词面 FAIL 和语义诊断并列展示，是否需要修订评测契约必须单独审查、版本化并重新执行验收。

### 混合业务契约 v2：自然表达与逐条复核

维护者已选择接受事实正确、来源正确的自然表达，不要求模型复述固定连续词。
历史 `contract_version=2` 保留原备份问题和词面事实，补全参考答案的
主体与阶段；回滚原题只检查明确问到的回滚对象和禁止项，新增迁移方式问题覆盖前向修复，合计 83 正例。
语料与拒答集不变。旧 Case ID 不代表旧 oracle 未变，比较时必须同时绑定 manifest SHA 与契约版本。

运行器仍输出原始机器结果，不将 Ragas 分数或人工复核写回 `score.ok`、`result`。
每次真实运行另存受限复核账本，包含原报告 SHA、run/case/request ID、契约版本、复核者身份/类型、
日期和逐题结论；代理复核必须标记 `agent`，不能写成维护者签字。

复核每个正例的主体、阶段、条件、数值/单位、否定极性、事实完整性及引用支持，并记录回答片段与对应的
原文/引用片段。结果分为 `supported`、`unsupported`、`insufficient_evidence`；词面通过也要复核，
不能只看失败题。无证据时不得猜测；来源错误、数字错误、遗漏或额外无依据结论不是“自然表达差异”。
实际引用或解析文本有疑问时回到原文件核对，不能拿后补检索伪装原请求证据。

HTTP/Provider 错误、非法引用、权限边界、入库、生命周期、拒答、延迟和清理失败必须独立阻断，
任何语义复核都不能豁免。只剩词面差异且逐项证据支持时，可报告“机器 FAIL / 代理复核支持”，
不称为自动 PASS；维护者确认复核结论后，才可进入候选镜像与香港发布验收。

当前混合业务契约为 **v3**：保留原合同问题和原文件，修正该题单一期限预期，要求同时呈现不同条款
口径和歧义提示；新增两个指定条款的正常回答对照，共 85 正例、10 拒答、25 文件。`expect_conflict`
分别要求已校验的冲突摘录或无冲突状态，不能只命中某个数字就通过。摘录数量不是冲突事实数量，
同一段落可能包含双方规定。机器分类/词面检查仍不能代替逐条语义与引用复核。v3 manifest SHA 同时绑定
业务清单、全部展开后的正/负例和原文件摘要，避免 A/B golden 改变却仍沿用同一业务指纹。
`testdata/business/evidence-conflicts.json` 提供不同动作、同条件、同片段、不同条件、指定条款、明确优先级及仅有
日期差异的合成 judge 对照；固定证据重放不是端到端检索或新鲜入库验收。历史 v2 机器 PASS / 语义 NO_GO
和中间失败均保留，不能重评分后覆盖。
矩阵 K 证明这一区别：合成对照 14/14 通过，但完整链路为 82/85 + 9/10、FAIL。后续对照必须加入完整
候选集合、来源元数据和干扰段落；缩减为已选片段后的通过不能代替运行时输入的结果。

默认最多 20 个样本、串行执行、200 次实际 HTTP 请求；超出必须显式调整。请求次数、输入字节、每次输出
Token、并发、单次请求、指标与整轮时间均有上限，SDK 内部重试也计入请求预算。不保证固定货币成本。
遥测和模型正文日志默认关闭，不自动上传 Langfuse，不把 Provider 异常正文写进报告。

输入、采集和报告位于已忽略的 `.unorag/evaluation/`，目录 `0700`、文件 `0600`，包含敏感上下文，须按
测试数据保留策略清理。语义结果只输出分数、状态、预算使用量和指纹，不重复正文；当前没有 Ragas 产品看板。
`informational_only=true`、`release_gate=not_evaluated`：分数先用于人工复核和方案对比，尚无通用放行阈值。
错误、超时、预算耗尽、缺上下文均不当作通过；退出 `0` 表示本次所需诊断完成，不表示质量合格或允许发布，
`2` 表示错误或诊断不完整。是否存在 `skipped`、缺哪组上下文仍须看逐项报告。

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
- `unorag.eval.citation_precision`；
- `unorag.eval.refusal_correct`。

发送内容仅包含 Session ID、哈希 case ID、run ID、release 和数值/布尔分数；不会发送问题、模型回答、
参考答案、关键事实或 Citation 正文。Langfuse 发布失败不会改写报告中的本地门禁结论，但显式要求发布
时命令会返回退出码 `2`，避免 CI 把未完成的发布动作记为成功。
当前没有自动同步 Langfuse Dataset；未来若增加，必须使用独立显式命令并确认测试数据允许出域。

多来源契约修复不追溯改写历史失败。`a71e14f` 候选验收仍为 NO-GO；修复后的 `59b4f5f` 已在新鲜、
版本绑定入库上通过三轮稳定性门禁，见[当前候选报告](./evidence/2026-11-04-59b4f5f-candidate-acceptance.md)。
后续提交仍须重新验收，不能以单元测试或重评分旧报告代替发布验收。

## Release Candidate 稳定性门禁

单轮 `eval:live` 用于开发诊断；正式 RC 使用连续三轮门禁：

```bash
pnpm eval:stability
```

稳定性 runner 将发布结论拆成两段：首轮创建临时知识库、上传全部真实文件并等待入库终态，作为
**Ingest Reliability Gate**；随后三轮 Ask 复用同一个不可变知识库，作为 **Ask Stability Gate**。
它不会为每轮重新调用 ParserProvider，也不会把 MinerU 等外部解析服务的偶发故障重复混入 Ask
稳定性。正常结束、门禁失败、`SIGINT` 或 `SIGTERM` 后均统一删除临时知识库。
总报告分别写入 `ingest_reliability_gate`、`ask_stability_gate` 和二者合取的 `release_gate`；任一门失败
都禁止发布，但故障归属保持清晰。

默认要求三轮中每个正例和拒答用例全部通过、`model_error` 为零、运行指纹完全一致，且任一轮 Ask
延迟 P95 不超过 15 秒。运行指纹包含仓库 Git commit、工作树 clean 状态、运行镜像 ref/digest、模型
名称及所有生产 Prompt 的版本和 digest；任一项缺失或工作树有未提交改动也会失败，避免对不可追溯
产物放行。

可通过 `--rounds=N` 和 `--max-p95-ms=N` 调整轮数与环境延迟预算。稳定性报告写入
`testdata/ab/_e2e_out/ab_stability_*.json|md`，逐题记录通过次数、失败轮次和 ingest、retrieval、
judge、table_answer、generation 等失败阶段。退出码仍为 `0` 通过、`1` 质量门禁失败、`2` 环境阻塞。

开发时可设置 `UNORAG_AB_LIBRARY_ID` 让单轮 `eval:live` 只对已有知识库执行 Ask；该模式从不删除调用方
提供的知识库。`eval:stability` 不接受该变量，因为 RC runner 必须自己创建并清理可追溯语料。

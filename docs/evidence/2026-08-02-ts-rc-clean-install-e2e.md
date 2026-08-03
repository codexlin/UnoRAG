# TypeScript RC 空环境、真实文件与恢复验收

- 日期：2026-08-02（Asia/Shanghai）
- 基线提交：`fe7eebed033608a69c583a7612eefa0670b00f9f`
- 候选形态：基线提交 + 本报告列出的未提交修复
- 环境：独立临时 worktree、独立 Compose project、独立 PostgreSQL/Qdrant/Redis/DBOS 卷
- 结论：**工程、运维与当前代表性质量矩阵 PASS；RC/预发布试点 GO；尚不等于无条件 production-ready**

## 1. 结论边界

本轮证明 TypeScript 主运行时可以从空环境安装，完成真实解析、索引、权限隔离、问答、故障恢复、备份恢复与失败升级回滚。初始基线为 20/33；在不删除失败用例的前提下完成质量专项后，同一份 33 条正例与 5 条拒答矩阵最终为 33/33 和 5/5。

因此应把结论拆开：

| 维度 | 结果 | 发布含义 |
|---|---:|---|
| 安装、运行时、生命周期 | PASS | 可以继续作为 RC 工程基线 |
| 租户、Workspace、ACL 隔离 | PASS | 未发现越权召回或 IDOR 泄漏 |
| 故障与恢复 | PASS | 依赖恢复后服务可自动恢复 |
| 真实文件入库 | PASS | 7/7 完成，PDF 均走真实 MinerU |
| 拒答 | PASS | 5/5，无资料问题全部拒答 |
| 复杂文档正例质量 | **PASS** | 当前代表性矩阵达到 RC 线 |

## 2. 本轮发现并修复

1. 空库迁移在运行时角色创建前执行 `GRANT`，导致 fresh install 失败。迁移改为角色存在时才授权，并增加静态契约测试。
2. 外部 Ask/Retrieve 对隐藏资源返回 404 的内部语义被错误投影。浏览器边界现在稳定返回 403，内部仍保持 404 防枚举语义。
3. PostgreSQL 重启会产生未处理的 Pool `error`。Web、worker、control 统一安装脱敏错误观察器，重启期间无进程退出。
4. MinerU 跨页表会被页眉页脚打断、误用 item id、误收续页表头。修复后真实 3 页表合并为一张 75 行表，行块为 33/34/8。
5. “表格中最大和最小”被模型规划成无条件 `filter`。现在根据明确问题词和真实表头强制归一为 `minMax`，成功聚合直接返回确定性执行结果，不再由 LLM 二次改写。
6. 表格证据过滤后沿用原始排名，界面出现 1、3。公共投影现在重新编号为连续 1、2。
7. 默认拒答文案把内部 library UUID 显示给用户。现在统一使用“当前知识库”。
8. TS 核心测试的 `server-only` 代理存在并发和文件内导入竞态。测试固定串行，受保护模块全部加载后才恢复解析器。
9. AB 评分器移除整段答案兜底，改用每例显式原子事实、中文数字/单位规范化与边界匹配，避免虚高分数。
10. Query Router 增加叙述型极值问题的确定性 `compare` 覆盖，并将汇总说明、图表文本与显式表格执行分开，避免模型路由漂移。
11. 非表格检索统一使用 `text` 逻辑粒度，覆盖 chunk/section/table summary 且排除原始表行；标题、章节与 preamble 现在同时进入 BM25、rerank 和生成上下文。
12. MinerU 连续同级首页标题会合并为完整文档标题；真实扫描件与双栏论文的标题问答均已恢复。
13. rerank 现在对请求所需的全部 `topK` 候选统一打分，不再混用 rerank 分数与 RRF 分数做同一阈值裁决；同文档的明显包含型证据会去重。
14. 多行 table lookup 不再只突出第一行，执行结果会输出所有命中行与确定性数值范围，避免 LLM 自行计算 min/max 时漏行。
15. 黄金集修正了两个过度断言：“项目名称”不再强制包含报告类型；图 4 问题只评分实际询问的部门与基础设施占比。评分器同时归一化 LaTeX 百分号和 Unicode 连字符。

## 3. 真实纵向验收

### 3.1 空环境与角色

- fresh migration、运行时数据库角色、bootstrap、Web、DBOS worker/control 均完成。
- Web、worker、DBOS 使用独立数据库登录角色。
- 生产健康检查：`live_ready=true`、`ask_ready=true`、`degraded=false`。

### 3.2 浏览器与权限

- 管理员真实登录、建库、上传、Ask、引用展开、归档入口：PASS。
- viewer 无建库、上传、删除、重建索引等写入口，仍可 Ask：PASS。
- 产品 UI 创建第二 Workspace，并在两个 Workspace 间切换：PASS。
- 第二 Workspace 无法看到第一 Workspace 的库和文档：PASS。
- 390×844 与 1440×900 实测均无横向溢出，关键控件无重叠：PASS。

### 3.3 隔离与 IDOR

- 跨 organization、workspace、session、service key：PASS。
- 外部 Ask/Retrieve 访问无权 library：稳定 403、无 citation：PASS。
- document/library/archive/debug IDOR：PASS。
- restricted ACL owner/viewer 差异：PASS。
- replace/delete 后旧版本不可见：PASS。

### 3.4 真实文件与表格

- DOCX、MD、TXT、本地数字 PDF、扫描 PDF、双栏 PDF、图表 PDF：均完成真实入库。
- HTML、CSV 经真实浏览器上传被拒绝，未产生文档或任务，台账保持稳定。
- 75 行跨 3 页真实 PDF：MinerU 解析、TableIR 合并、Qdrant 分块、行级证据均通过。
- 浏览器实问全表最值：最小 42,996（第 29 行），最大 5,673,173（第 57 行），返回 2 条行级证据：PASS。

## 4. 故障与恢复

| 场景 | 结果 | 关键证据 |
|---|---:|---|
| PostgreSQL 重启 | PASS | Web/worker/control restart count 均为 0；恢复后 Ask 正常 |
| Qdrant 停止/恢复 | PASS | 停止时 Ask 503 fail-closed；恢复后答案与引用正常 |
| worker 停止/恢复 | PASS | 停止期间上传保持 queued；恢复后自动完成 |
| 备份校验 | PASS | PostgreSQL、DBOS、对象、Qdrant、manifest 五项 checksum 通过 |
| 破坏性 restore | PASS | 恢复前后计数与 Qdrant 90 点一致；备份后标记库消失 |
| restore 后浏览器 Ask | PASS | 登录态可用，答案“返岗后三个工作日内”且引用原文 |
| 不存在镜像升级 | PASS | 升级失败，runtime 配置哈希恢复，旧服务自动健康 |
| 生命周期巡检 | PASS | dead=0、stuck=0、cleanup error=0、pending ACL=0 |

## 5. 自动化门禁

| 命令 | 结果 |
|---|---:|
| `pnpm test` | 161 pass / 1 skip / 0 fail |
| `pnpm test:ts-core` | 231 pass / 12 skip / 0 fail |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS |
| `python3 -m unittest tests.test_run_ab_live_e2e` | 6/6 PASS |

跳过项需要显式外部 PostgreSQL/Qdrant E2E URL；本轮对应能力已由独立 Compose 真实纵向测试覆盖。Web runner 与 DBOS worker 使用独立镜像标签重建，两个容器均健康；避免了不同 Docker target 共用临时标签的构建竞态。

## 6. 真实 AB 质量结果

### 6.1 初始基线

初始空环境纵向测试为 7/7 入库、20/33 正例、5/5 拒答，document recall@k 69.70%、MRR 67.68%、跨文档 citation 30.36%。失败覆盖大表表头、文末汇总、扫描标题、双栏论文、叙述型极值和图表问题。该基线是本报告上半部分质量修复的起点，不是最终发布数据。

### 6.2 最终复验

- 新建知识库 `5f563fe7-cd14-4d50-8332-13f095d07d66`，7/7 份真实文件全部重新上传并入库成功。
- PDF 均通过真实 302.AI MinerU 生产路径，不是 Fake parser/index。
- 首轮修复后全量结果为 31/33；保留同一知识库修复最后两个边界后，重新执行全部 33+5 条 Ask。
- 最终正例：**33/33，100%**。
- 最终拒答：**5/5，100%**。
- document recall@k：**100%**。
- document MRR：**97.98%**。
- 跨文档 citation 比例：20.77%；所有正例均至少包含目标文档引用，但该比例仍是后续降噪优化项。
- 正例延迟：P50 7.84s，P95 13.29s，最大 17.41s。
- 含拒答在内的 38 次 Ask：P50 7.58s，P95 17.41s，最大 19.80s。

当前矩阵达到 RC 质量线。未来增加新文件类型、新模型或变更 chunk/retrieval 策略时，必须重跑该矩阵，不得用本次 100% 结果替代新数据的验收。

## 7. 最终判定

**GO for RC / 内部预发布 / 受控试点。**

本结论允许合入 RC 分支、制作候选镜像，并在目标预发布环境执行部署与浏览器复验。

它不单独授予“任意客户数据 production-ready”宣称。正式客户发布仍需绑定确切
commit/镜像、客户模型与解析 Provider，并按照 [`../RELEASE.md`](../RELEASE.md)
在目标环境完成签字型 go/no-go。

# Private Deployment v1.0 RC3 真实浏览器验收

> 日期：2026-07-27
> 代码基线：`a255752`
> 环境：本地 Docker Compose 完整栈，入口 `http://localhost:8088`
> 结论：**PASS（产品主路径）**

## 范围

本轮不是接口级 smoke 的替代，而是使用真实浏览器、真实管理员会话、
真实 PostgreSQL / Qdrant / worker / live 模型完成产品主路径：

`登录 → 创建知识库 → 上传 → 索引 → Ask → 引用 → Trace → 归档 → Service Key`

同时验证桌面端与 `390 × 844` 移动端的 Ask、知识库和设置页面。

## 真实 E2E 结果

| 检查项 | 结果 | 证据摘要 |
|---|---|---|
| 登录与工作区会话 | PASS | 本地管理员真实登录 |
| 创建知识库 | PASS | `RC3 浏览器验收知识库` |
| Markdown 上传与索引 | PASS | `unorag-rc3-browser-e2e.md`，3 chunks，状态就绪 |
| live Ask | PASS | “员工返岗后需要在几天内补交病假证明？”→“三个工作日” |
| 引用正确性 | PASS | 首条引用命中验收文档“请假制度”，top score `0.85` |
| 关联 ID / Trace | PASS | `ecdd5510-e6dc-49d2-ac75-63a09cb4596b` |
| 阶段耗时 | PASS | retrieve `1.12s`，generate `967ms`，服务端合计 `3.43s` |
| 端到端耗时 | PASS | 浏览器点发送至回答完成 `8.14s` |
| 会话归档 | PASS | 归档列表可见，答案与引用可回看 |
| Service Key | PASS | UI 创建、一次性明文、吊销与吊销后清理均通过 |
| 浏览器 console | PASS | 最终轮 `error=0`、`warn=0` |
| 移动端 Ask | PASS | 来源改为抽屉；关闭时输入与内容不再被固定侧栏挤压 |
| 移动端知识库 | PASS | 列表在上、文档区在下；文档表内部横向滚动 |
| 移动端设置 | PASS | 页面 `clientWidth=390`、`scrollWidth=390` |

测试生成的 Service Key 均已吊销；报告不记录任何明文凭据。

## 本轮发现并修复

1. **知识库列表 500**
   - 原因：reindex 关联子查询中的外层 `id` 在 PostgreSQL 中变成歧义列。
   - 修复：明确限定 `app.libraries` 的外层字段，并增加回归测试。

2. **历史删除后 `doc_count` 不回落**
   - 原因：delete completion 只刷新 `ready_count/status`。
   - 修复：worker 同步刷新 `doc_count`；新增幂等迁移
     `0010_reconcile_library_counts.sql` 修复升级前脏数据。
   - 本地迁移验证：汇总由错误的 `5 个库 · 4 文档` 恢复为
     `5 个库 · 2 文档`。

3. **移动端 Ask 来源栏阻断核心路径**
   - 原因：360px 桌面侧栏在 390px 视口仍参与 flex 布局。
   - 修复：移动端使用右侧 Sheet，桌面端保留固定来源栏。

4. **移动端知识库双栏挤压**
   - 修复：小屏上下分层，大屏维持左右双栏；表格滚动限定在容器内。

5. **移动端设置横向溢出**
   - 原因：Grid 子项默认最小内容宽度被审计表撑开。
   - 修复：Grid 子项允许收缩，审计表在自身容器滚动。

6. **Service Key 明文生命周期**
   - 修复：新增“清除明文”；吊销成功后立即清除明文与复制状态。

7. **产品文案与可访问性**
   - 首页从 `v0 · scaffold` 更新为 `Private Deployment · v1.0`，
     明确 Knowledge Service / Workspace / Public API 定位。
   - 移除“模式 B”实现术语；本地化侧栏与弹层关闭名称；Trace 阶段增加
     明确的可访问名称。

8. **Docker 构建上下文**
   - 新增 `.dockerignore`，排除依赖、缓存、真实环境变量与验收工作目录。
   - 构建上下文从数百 MB 降至本轮约 `30–106KB`，并阻止环境文件进入镜像上下文。

## 质量门禁

| 门禁 | 结果 |
|---|---|
| API pytest | PASS · `307 passed / 8 skipped` |
| Web tests | PASS · `105 passed / 3 skipped` |
| Web lint | PASS · 仅 Biome 配置弃用提示 |
| Next production build | PASS |
| pilot-preflight isolation | PASS · `2/2` |
| CI release gate | PASS · `36/36` |
| 数据迁移真实执行 | PASS |

Web 测试首次与全量 Python 测试并行时，定时续租用例因机器负载只采到一次
timer tick；该用例单独复跑及 Web 全套串行复跑均通过，不构成产品失败。

## 非阻断观察

- 当前测试库还包含一份 `contract-long.docx`，dense 检索返回 4 条引用时有
  2 条低相关引用（`0.59 / 0.58`）。答案只引用了正确的第 1 条，因此不影响
  本轮 PASS；后续可把“引用展示数量/阈值”和检索评测作为质量优化项。
- 本轮创建的浏览器验收知识库和文档保留在本地环境，便于复核；不属于发布镜像数据。

## 结论

`a255752` 已通过本地完整私有化栈的真实浏览器主路径、移动端关键页面、
生产构建与发布前质量门禁。它可以作为 Private Deployment v1.0 的
RC3 产品代码候选；正式对外发布仍沿用既有审批与签字流程。
RC3 专属签字材料见
[`2026-07-27-private-v1-rc3-formal-go-no-go.md`](./2026-07-27-private-v1-rc3-formal-go-no-go.md)。

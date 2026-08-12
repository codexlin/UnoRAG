# UnoRAG v0.1.0-rc.12 生产候选验收

- 日期：2026-08-12（Asia/Shanghai）
- 提交：`118a3e7444569883fce42b03cb2fedda9373a1fd`
- 发布：[`v0.1.0-rc.12`](https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0-rc.12)
- DBOS application version：`unorag-118a3e7444569883`
- 环境：UnoRAG-HK，公网 `https://unorag.unobyte.dev`
- 结论：**RC.11 生产验收发现的两项问题已修复；RC.12 发布、真实文件、稳定性、浏览器隔离、维护恢复及回退前滚全部 PASS**

## RC.11 发现与修复

RC.11 三轮稳定性测试中有一条 Ask 在 QueryRouter 之前以 `TypeError` 失败；对应
`app.ask_runs` 记录仅运行 224 ms，尚无 query type、retrieval mode 或 citation，定位为查询
embedding 的瞬时 transport failure。RC.12 对 embedding / rerank transport 与
`408/425/429/500/502/503/504` 增加有限、可中断重试，鉴权和其它永久错误不重试；失败记录改用
`embedding_transport_error` 等稳定、隐私安全错误码。

RC.11 维护窗口备份还发现公网 Compose overlay 只存在于调用者 shell，脚本重启 Caddy 时可能回到
基础拓扑。RC.12 将 `UNORAG_COMPOSE_OVERLAY` 持久化在 `deploy/config/runtime.env`，所有
backup / restore / upgrade 命令自动复用同一部署拓扑，并有真实 shell 参数回归测试。

## 确定性门禁与发布物

- PR #47 五项 CI 全部通过：Web/TS Core、Docker build、secret scan、brand residue 和 diff lint。
- 本机额外通过 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test` 与
  `pnpm test:ts-core`；TS Core 为 327 PASS、19 个外部依赖用例 SKIP、0 FAIL。
- Release workflow 构建并推送 web、migrator、ops、worker 四个 `linux/amd64` digest。
- 四个镜像 HIGH / CRITICAL Trivy 扫描全部通过；OCI index 含 SPDX SBOM 和 SLSA provenance。
- GHCR manifest 已挂到 GitHub Release；HK 运行的 web digest 为
  `sha256:a2ba86185c92761f207dfd1f3756fb34d82b8991208edf3cc34ac1d705d893ee`。

OCI SBOM / provenance 由 BuildKit 生成但尚未做 Cosign 或 GitHub artifact attestation 签名；签名仍是
稳定 `v0.1.0` 前的发布门禁，不影响本 RC 的运行时验收结论。

## HK 升级与维护窗口

- RC.11 到 RC.12 按精确 digest manifest 升级；旧 DBOS version 在停机前
  application / DBOS active 均为 0。
- forward-only migration、runtime role 校验、ACL projection reconcile 与 lifecycle gate 全部通过。
- 内置 smoke 真实完成 upload → Ask → Public Retrieve/Ask → scope/revoke/isolation → replace → delete。
- 持久化 overlay 的真实备份回归生成 PostgreSQL、DBOS、documents、Qdrant 和 manifest，五项 SHA-256
  全部通过；服务重启后 Caddy label 同时包含基础和 public Compose 文件，HTTPS ready 保持正常。

## 真实文件与稳定性

通过公网产品 API 重新上传以下七份文件：长合同 DOCX、80 行报价表 DOCX、长叙述 Markdown、三页跨页表
PDF、混合图表 PDF、低对比扫描 PDF 和双栏 PDF。复杂 PDF 均经过生产 MinerU 队列。

- 入库：**7/7 completed**。
- 三轮正例：**33/33、33/33、33/33**。
- 三轮拒答：**5/5、5/5、5/5**。
- 稳定轮次：**3/3 PASS**，无不稳定 case。
- 模型错误：**0**；构建指纹一致：**true**。
- 最大单轮 P95：**13.684s**，低于 15s 门槛。

本地详细报告保存在 gitignored 的
`testdata/ab/_e2e_out/ab_stability_20260812T135816Z.md`，不会随仓库发布。

## 真实浏览器与隔离

使用实际浏览器完成管理员登录、创建知识库和文档台账检查。真实 `handbook.md` 入库后 UI 显示
`1/1 可检索`、7 个知识片段；浏览器提问“病假材料应在什么时候补交，需要什么证明？”得到正确答案，
展示 2 条原文引用。链路面板显示 8 个阶段、trace id、324 ms 检索、6.31s Judge、883 ms 生成，
浏览器端到端耗时 8.90s。

随后从产品 UI 创建第二工作区 `RC12 隔离空间`：切换后知识库列表为空，主工作区文档和会话均不可见；
切回 `UnoRAG HK` 后原知识库恢复可见，跨 Workspace UI 隔离 PASS。产品目前没有删除 Workspace 能力，
该空隔离空间被保留；验收知识库及其两份文档已通过产品异步删除完成清理。

运行中心正确显示 RC.12 revision / DBOS version、Ask 质量、100% citation coverage、队列、组件健康、
告警与历史 RC.11 错误。

## 故障恢复与版本回退

- Qdrant 停止：`/health/live=200`、`/health/ready=503`；恢复后 ready 回到 200。
- DBOS worker 停止：新上传任务保持 `queued`；恢复 worker 后同一 job 自动完成。
- RC.12 回退 RC.11：drain、迁移、smoke 和隔离全部 PASS，线上版本确认 `0.1.0-rc.11`。
- 使用原 RC.12 manifest 再前滚：同一组门禁再次 PASS，线上版本恢复 `0.1.0-rc.12`。

最终公网健康为 `ask_ready=true`、`degraded=false`，revision、web digest 和 DBOS version 均精确匹配
RC.12；`dead / stuck / deleting / cleanup / pending ACL projection` 全部为 0。

## 结论与剩余门禁

RC.12 可作为当前唯一有效的生产候选。稳定 `v0.1.0` 仍需完成素材与 fixture 权属确认、完整第三方
NOTICE、镜像签名和最终品牌/商标检查。持续运维方面仍建议增加异机备份和独立外部探活。

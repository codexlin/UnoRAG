# webch 预发布基线验收

> 日期：2026-07-28 至 2026-07-29（UTC+8）
>
> 环境：`https://webch.cn`，阿里云 Docker Compose
>
> 定位：模拟线上真实拓扑的预发布环境，不是正式客户生产环境

## 结论

本轮代码在真实 HTTPS、真实浏览器、真实 PostgreSQL/Qdrant、真实文档与 live
模型链路上的验收为 **PASS，0 FAIL**。服务在故障演练后已恢复，验收结束时
health、Ask、lifecycle jobs 与 outbox 均无阻断状态。

24 小时 soak 是持续观察项，不作为本次预发布基线提交的阻断条件。本报告不将它
写成客户生产 SLA 或通用 production-ready 证明。

## 覆盖矩阵

| 领域 | 结果 | 已验证内容 |
|---|---|---|
| 登录与浏览器主路径 | PASS | 真实登录、响应式 UI、Library、上传、Ask、Archive、Settings |
| 真实文档入库 | PASS | Markdown、DOCX 表格、扫描 PDF；Job 到 ready，引用可回到正确文件 |
| 有据问答 | PASS | 流式回答、引用、追问、无覆盖拒答、表格命中行引用 |
| 文档生命周期 | PASS | 上传、replace、reindex、delete；新版本原子激活，计数与列表同步 |
| Workspace 创建 | PASS | organization owner/admin 创建第二 Workspace，自动切换 |
| Workspace 切换 | PASS | session 重新签发，完整导航，切回后原数据恢复 |
| Workspace 隔离 | PASS | 新 Workspace 为 0 Library / 0 Document；跨 Workspace library ID 返回 404，不泄漏内容 |
| 创建幂等 | PASS | 相同 Idempotency-Key 与请求体返回同一资源；不同请求体返回 409 |
| ACL | PASS | Workspace、Library 与 restricted document 对照；检索不越权 |
| Service Key | PASS | 创建、Retrieve/Ask、吊销、审计与密钥不落审计详情 |
| Qdrant 故障 | PASS | 停止后 health/Ask 正确失败；恢复后 Ask 200 |
| Worker 故障 | PASS | lifecycle/outbox 暂停产生积压，恢复后继续处理；dead=0 |
| 备份完整性 | PASS | PostgreSQL、documents、Qdrant 与 manifest 非空、可解包 |
| 非破坏恢复 | PASS | sidecar PostgreSQL 恢复成功，`app`/`rag`/`drizzle` schema 可读 |
| 生产原地恢复 | DEFERRED | 破坏性操作，不在无正式维护窗口的预发布环境覆盖 |
| 容量与并发 | DEFERRED | 未在目标客户规格上形成 P50/P95 与最大并发承诺 |

## 本轮修复后复验

- 拒答、弱证据、模型未覆盖时不再携带仅为调试用途的候选 citation。
- 扫描申请表不会仅因“表中”误入 TableIR 路径。
- 表格命中行进入最终 citations，并排在无关文本证据之前。
- 删除完成后的文档计数与立即投影一致。
- Service Key 创建/吊销审计与事务边界一致，吊销幂等。
- Ask 初始加载与真实服务故障分开显示。
- Archive 中已删除的 Library 不会静默切换到当前 Library。
- Workspace 下拉菜单真实浏览器运行正常。
- 创建/切换第二 Workspace 的产品纵向切片已补齐。

### Library 终态一致性复验

2026-07-29 部署 `d37181f` 与 Web 收口提交 `5be31e0` 后，完成数据库迁移、
Compose pilot smoke 和真实 Chromium 复验：

- Library 汇总状态与 document/job 终态在同一事务内收敛；
- 历史漂移已修复，`302CN3 = failed (0/1)`，不再显示处理中或已索引；
- `302CN-rewrite = degraded (3/5)`，旧 active generation 仍可正常检索；
- 失败且无可检索文档的 Library 禁用“开始提问”，不会静默切换到其他 Library；
- 从可检索 Library 进入 Ask 后保持正确选择，真实回答命中
  `POST_FAULT_RECOVER_OK_TOKEN_20260728` 并返回引用；
- Chromium 控制台 0 error，桌面视口无横向溢出；
- lifecycle `dead=0`、`stuck=0`，outbox `dead=0`。

证据截图：

- [Landing 桌面视口](assets/2026-07-29-webch-landing-desktop.png)
- [Landing 移动视口](assets/2026-07-29-webch-landing-mobile.png)
- [失败 Library 的终态与禁用入口](assets/2026-07-29-webch-status-fixed-failed.png)
- [部分可检索 Library 的 3/5 状态](assets/2026-07-29-webch-status-fixed-libraries.png)
- [真实问答与引用](assets/2026-07-29-webch-status-fixed-ask.png)

## 自动化门禁

本轮功能提交前的最终数字以 CI / 本地完整测试输出为准。已执行的预发布门禁包含：

- API pytest 与 deterministic eval；
- Web Node tests、Biome、Next.js production build、Drizzle check；
- Python/JavaScript policy parity；
- Compose pilot smoke；
- release image build/scan 配置；
- `git diff --check`。

## 运行态收尾

验收结束时：

- `/api/rag/health` live / ask / Qdrant ready；
- lifecycle jobs `dead=0`、无 active stuck；
- outbox `dead=0`；
- 临时 Workspace、Library、Document、Service Key 与测试数据已清理；
- Qdrant、lifecycle worker、outbox worker 已恢复。

## 仍不应宣称

该报告不能证明以下事项已经完成：

1. 任意客户规格下的容量与高并发 SLA；
2. OIDC/SSO 与企业目录同步；
3. 多 organization 产品管理；
4. S3/MinIO 一等对象存储；
5. Kubernetes HPA/PDB/NetworkPolicy；
6. SBOM、镜像签名与 provenance；
7. 公开 Documents/Versions/Jobs API；
8. ChartIR 或超大表数据库执行。

上述边界的权威状态见 [`../../STATUS.md`](../../STATUS.md)，客户正式上线按
[`../production-ready-checklist.md`](../production-ready-checklist.md) 单独签字。

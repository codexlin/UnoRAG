# UnoRAG-HK RC.8 主机验收

- 日期：2026-08-10（Asia/Shanghai）
- 提交：`a5b4ce5adb30dc0e3a3c71df6eaa2700708aa6b4`
- DBOS application version：`unorag-a5b4ce5adb30dc0e`
- 发布物：RC.8、`linux/amd64`、四镜像 digest 固定
- 环境：香港单机 Compose，2 vCPU、4 GiB RAM、80 GB 系统盘、2 GiB swap
- 结论：**应用、真实文件、数据恢复、DNS 与公网 HTTPS 验收 PASS；异机备份和外部监控仍需补齐**

## 主机与安装

- Ubuntu 24.04 LTS 完成系统升级并切换到更新后的内核。
- Docker Engine、Compose v2、日志轮转、`live-restore`、低 swappiness 和无人值守安全更新已启用。
- 应用使用独立 Postgres root、Web、Worker、DBOS、Session 和管理员凭据；真实 Secret 均为 `0600`，未进入仓库或报告。
- PostgreSQL、Qdrant、Redis、Web、DBOS worker/control 和 Caddy 均健康。
- 公网仅开放 Caddy 的 80/443，宿主机同时保留 `127.0.0.1:8088` 维护入口；数据服务和 Worker 未发布端口。
- ACR 与 GHCR manifest 的四个 digest 逐项一致。首次安装从 ACR 拉取；拉取完成后已删除服务器 Registry 登录信息。

## 真实纵向验收

内置 pilot smoke 完成以下真实流程：

- 管理员登录、双文库创建、Markdown 上传与异步入库；
- 浏览器 Ask、Public API Retrieve/Ask、服务密钥 scope 与撤销；
- 跨文库零引用泄漏；
- 文档 replace、原子版本切换与异步 delete。

结果：**PASS**，生命周期巡检为 `dead=0`、`stuck=0`、`cleanup_errors=0`、`pending_acl_projections=0`。

## MinerU 与质量门禁

Live evaluation 从客户端经 SSH 隧道访问 HK 服务，重新上传七份代表性真实文件：长合同 DOCX、80 行报价表 DOCX、长叙述 MD、低对比扫描 PDF、双栏 PDF、三页跨页表 PDF 和混合图表 PDF。

- 入库：**7/7 completed**。
- 复杂 PDF：日志确认真实 `302.AI -> MinerU submit/poll/fetch`，未使用 Fake parser/index。
- 正例：**33/33 PASS**。
- 拒答：**5/5 PASS**。
- 原子事实覆盖：**100%**。
- 文档 Recall@K / MRR：**1.000 / 1.000**。
- Citation precision：**100%**。
- 跨文档 Citation：**0%**。
- Ask 延迟 P50 / P95：**5.60s / 10.84s**。

本机评测 runner 使用 Node 20，而仓库声明 Node 22，因此产生 engine warning；远端产品镜像仍是发布 workflow 认证的运行时。runner 还尝试在本机 Docker inspect 远端镜像引用并报告 image missing，不影响远端 digest 核验或质量门禁，最终 release gate 为 PASS。

## 备份、恢复与重启

恢复演练先创建带唯一标记的知识库并完成 Ask，然后执行维护窗口备份：

- 主业务 PostgreSQL plain dump；
- DBOS system database custom dump；
- 文档对象归档；
- Qdrant 冷备；
- manifest 与五项 SHA-256 校验。

备份后真实删除该知识库，确认其从授权列表消失，再执行破坏性 restore。恢复脚本校验全部 checksum 后恢复四类数据；同一 library ID、唯一标记、答案和 Citation 均重新可用。恢复后生命周期巡检仍为零异常。

随后执行宿主机重启，UnoRAG 在约 20 秒后恢复 ready；所有长期容器自动健康，恢复知识库再次 Ask PASS。重启后约占用 945 MiB 内存、0 swap，根盘使用率约 10%。

## DNS 与公网 HTTPS

- 权威 DNS 与公共解析器均确认 `unorag.unobyte.dev` 指向 HK 主机。
- Caddy 使用持久化 `/data` 与 `/config` 卷完成 Let's Encrypt 证书签发和自动续期配置。
- HTTP 返回 `308` 并跳转到 HTTPS；TLS 证书域名为 `unorag.unobyte.dev`。
- 公网 `/api/rag/health/ready` 返回 `200`，`ask_ready=true`、`degraded=false`。
- 真实浏览器成功加载 Landing Page；访问 `/app/ask` 正确跳转 `/login`，控制台无 error/warn。
- `/metrics` 与 `/api/metrics` 继续由边缘代理返回 `404`，未暴露内部指标。

## 上线后待办

1. 配置独立外部探活和证书到期告警。
2. 将备份复制到异机或对象存储；本机备份只证明恢复流程，不抵御整机或磁盘损坏。
3. HTTPS 与外部监控连续稳定后，再退役腾讯回退实例。

HK 主机现已具备正式公网服务条件。上述待办属于持续运维与灾备强化，不影响当前功能验收结论。

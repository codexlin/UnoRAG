# a71e14f 候选发布验收

> 日期：2026-11-04。结论：**NO-GO，未发布稳定版，未升级正式实例**。
> 本报告只证明下列提交、镜像、配置和独立环境；不能继承旧版 PASS 或外推为客户容量保证。

## 候选与环境

- 提交：`a71e14f69397678854bc3602241412960a4ca3b4`，产品版本 `0.2.3-dev+a71e14f69397`。
- DBOS application version：`unorag-a71e14f693976788`；四镜像平台均为 `linux/amd64`。
- [精确提交 CI](https://github.com/codexlin/UnoRAG/actions/runs/41821311743) 与
  [候选四镜像发布](https://github.com/codexlin/UnoRAG/actions/runs/41825910714) 均通过。
- 香港参考主机上的独立 Compose 项目，独立数据库、Redis、Qdrant、凭据和文档作用域；只绑定 loopback。
  主机为 2 vCPU / 4 GB RAM，与原稳定实例共用硬件，没有使用平台模拟。各入库队列并发为 1，
  LLM 并发上限为 2；不据此出具容量或 SLA 承诺。
- 实际外部链路：腾讯 COS、DashScope `qwen-plus`、`text-embedding-v3`，以及 302.AI MinerU。
  云端模型名称不是不可变权重标识，结果只对应本次运行时点。

| 镜像 | GHCR index digest |
|---|---|
| Web | `sha256:ec92247533ef94566d780d24aaa574446fe0d2b45660ea7d3730731612046535` |
| Migrator | `sha256:91b6f1402eb61e94b4c2dcb2e1227dcacc5aa10c93accb5ae2512c91046cb63c` |
| Ops | `sha256:3939f2d1de37949a70237a96e4f0bb46654436c61845d47766241e0c8fd4f038` |
| Worker | `sha256:f052a16eab919461429036f8bb6e3315120a8adc76fe04f4387946deb0b27d02` |

四镜像 Trivy HIGH/CRITICAL 门禁按现有 `ignore-unfixed` 策略通过，未增加豁免；Cosign 签名和自验通过。
另外读取了各 index 的 amd64 runtime 与关联 attestation，四者均具有 SPDX SBOM 和 SLSA provenance v1。
候选 artifact 保留期为 30 天，报告保存完整 digest，不依赖浮动 tag。

## 执行结果

| 门禁 | 结果 | 范围 |
|---|---|---|
| 精确提交 CI | PASS | 五项必需检查，含真实 PG / Qdrant / Redis 集成与镜像构建 |
| 新实例安装 | PASS | 从已签名的 `v0.2.3` manifest 安装；独立管理员完成首次改密 |
| 升级 / 回滚 / 再升级 | PASS | 旧版与候选 digest 切换；任务排空；同一资料的 Ask、引用与 active version 前后校验 |
| 产品 smoke | PASS | 真实上传、Ask、Service Key、Public API、权限范围、替换和删除 |
| 浏览器 | 20/20 PASS | 桌面 / 移动 Chromium；其中高频流、竞态和部分归档响应为受控 fixture，不冒充真实模型测试 |
| 新鲜入库 | 7/7 completed | 4 份 PDF 经真实 302.AI MinerU；其余为 DOCX / Markdown 原生处理 |
| 三轮 Ask 稳定性 | FAIL | 正例 `35/36`、`34/36`、`35/36`；拒答每轮 `5/5`；现有门禁通过轮数为 `0/3` |
| S1/S2 隔离 | BLOCKED | 已记录 6 项通过；跨 Workspace 公共 Ask 返回错误分类不正确，后续检查未执行 |
| Provider 故障 | PASS | LLM 401/429/503、Embedding 超时/401、MinerU 401；失败替换保留旧版并验证恢复 |
| 补充会话真链路 | PASS | 临时问答、归档、真实模型追问；删除来源后 `200 + refused`、无旧内容与引用 |
| 破坏性恢复 | PASS | 独立实例真实备份 / 删卷 / 恢复；恢复就绪 36 秒，探针丢失为 0 |

## 质量结果与发布阻断

三轮运行指纹一致，P95 分别为 `13,345 ms`、`14,829.8 ms`、`14,141.8 ms`，均未超过本次
`15,000 ms` 门槛。第二轮最大延迟为 `30,431.8 ms`。跨页表与低对比扫描专项全部通过。
新鲜入库没有失败页；两份 DOCX 因 Mammoth 的 `Title` 样式警告被标记 partial，警告未被隐藏，
现有 Provider 门禁没有将其判为数据丢失。

1. **黄金集单源契约冲突**：[Issue #172](https://github.com/codexlin/UnoRAG/issues/172)。
   用例 `0a75cfac32601f6b` 三轮均命中全部事实和目标文档，但还引用了 `mixed-charts.pdf`。
   人工核对该 PDF 后，确认它独立记载同一项目的投资预算；现有文件名排他规则仍将其计为失败。
   需要显式建模可支持哪些事实的补充来源，并继续拒绝无关或冲突引用，不能直接允许任意额外文件。
2. **Judge 可用性与错误语义**：[Issue #173](https://github.com/codexlin/UnoRAG/issues/173)。
   用例 `27cb273c3e089f94` 在第二轮检索约 `308 ms`、召回 6 条候选，但 Judge 耗时约 `30 s` 后
   返回 `judge_unavailable`。用户文案却表示知识库资料不足，Judge 阶段还记录 `ok=true`。
   该题另两轮通过，不能用其通过结果覆盖这次真实模型错误；应补故障文案、阶段语义和预算诊断。
3. **公共 API 拒绝被转换成上游故障**：[Issue #174](https://github.com/codexlin/UnoRAG/issues/174)。
   `S2.A1_key_foreign_lib_A2` 已被底层授权拒绝，但公共适配器把拒绝映射成可重试的
   `502 upstream_unavailable`。没有观察到越权内容，但套件正确中止为 BLOCKED，不能宣称隔离全部通过。
   修复应保留不泄露外部资源信息的非重试拒绝，并重跑完整套件，而非把 5xx 当安全通过。

上述 4 次正例失败、1 次真实模型错误和隔离中止都保留原结果；没有修改正式评分器、问题、模型或阈值
挑选绿灯，也没有关闭 Judge。正式实例保持 `v0.2.3`，候选依赖安全修复尚未部署到该实例。

## 恢复与证据边界

备份校验和通过，PostgreSQL、DBOS system database 和 Qdrant 在删卷后恢复。应用约 36 秒就绪，
恢复探针的 active version 与原值一致，真实 Ask 返回正确引用；最终巡检为
`dead=0 / stuck=0 / pending ACL=0`。这是样本级恢复观察，不是所有数据的零丢失承诺。

COS 对象保留在原桶中，备份只包含 COS 边界说明；本次恢复探针验证版本与 Ask，未单独下载恢复前的
源文件。未验证对象误删、桶级恢复或跨区域复制；这些仍是客户对象备份与 RPO/RTO 的独立门禁。
正式实例没有执行破坏性恢复；本轮临时实例在归档后清理，不保留额外常驻服务。

原始结果位于私有验收工作目录的 `upgrade-rollback/`、`provider-faults/`、`restore/`、
`attestations.json`、`conversation-live.json`、`isolation.log`，以及评测输出目录中的
`ab_live_20261104T121623Z-ea7c3d95.json`、`ab_live_20261104T122328Z-ec160103.json`、
`ab_live_20261104T122844Z-306fb050.json` 和 `ab_stability_20261104T123409Z.json`。
公开仓库只保存脱敏汇总；密码、备份、完整问题/回答和环境文件不入 Git。

执行过程还保留以下工具问题，不混入产品质量分数：隔离 bootstrap 首次因宿主 Node 缺少数据库连接
而 BLOCKED，随后改用现有容器 bootstrap；补充会话脚本先漏传清理超时，随后又错误要求固定 403，
修正为当前契约的安全行为断言后完整重跑。原失败记录保留，正式黄金集结果未重算。

另有非阻断的版本元数据缺口：DOCX `parser_report` 仍写 Mammoth `1.10.0`，而候选锁文件安装的是
`1.12.3`。本报告以锁文件为依赖版本依据，不把该字段当作实际组件版本证明。

## 下一步

先修复公共拒绝映射，再收口 Judge 故障语义和诊断，最后完善多来源黄金集契约；三者都需要行为回归。
之后重新构建绑定新提交的四镜像候选，重跑新鲜入库、三轮 Ask 和完整隔离门禁。
本次其余 PASS 不自动传递给修复后的候选，不能据此创建稳定发布或升级正式实例。

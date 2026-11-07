# 验收证据

当前树只保留一份当前发布报告和一份试点模板。历史失败、实验和发布结果使用固定提交链接追溯，
不再与现行指南混排，也不把旧 PASS 自动继承到新代码或客户环境。

## 当前证据

| 文档 | 用途 |
|---|---|
| [v0.2.7 发布收口验收](./2026-11-07-v0.2.7-release-closeout.md) | 最终签名镜像与香港验收：25 文件、三轮 285/285、生命周期 8/8、浏览器 36/36、真实 SSE 3/3、隔离 29/29；保留失败和限制 |
| [试点反馈模板](./PILOT-FEEDBACK-TEMPLATE.md) | 记录客户场景、版本、证据和责任签字；模板本身不证明通过 |

## 历史证据

以下原文均固定在清理前提交 `6918b7596f77974cc036c15a3f3140aa89a95aef`，不随 main 改变。
正文中的版本、环境与阶段性结论保持原样，包括 FAIL、NO_GO、超时和未知根因。

| 原文 | 保留原因 |
|---|---|
| [混合业务质量调查](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-06-business-matrix-hk.md) | 原 HK FAIL、预期修正、K/L 裁决回归、M 传输故障与最终本地复验 |
| [v0.2.5](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-06-v0.2.5-release-closeout.md) | 窄屏显示与 ACR 修复，七文件发布验收 |
| [v0.2.4](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-06-v0.2.4-release-closeout.md) | 解析预算与请求诊断，发布和恢复 |
| [b0222ea](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-06-b0222ea-hk-acceptance.md) | 候选质量、隔离与 Qdrant 同进程恢复 |
| [比较证据修复](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-05-comparison-lineage-fix.md) | 证据丢失、重排降级的根因及成本对比 |
| [d9b1377](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-05-d9b1377-hk-acceptance.md) | 部署成功但质量 FAIL 的前后对照 |
| [Ragas/请求记录](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-05-ragas-request-records-local.md) | 本地语义诊断与质量缺口，不是发布认证 |
| [c066377](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-05-c066377-parser-upload-acceptance.md) | 解析通过但延迟门禁 FAIL |
| [59b4f5f](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-11-04-59b4f5f-candidate-acceptance.md) | 旧隔离候选基线与当时的限制 |
| [v0.2.3](https://github.com/codexlin/UnoRAG/blob/6918b7596f77974cc036c15a3f3140aa89a95aef/docs/evidence/2026-09-25-v0.2.3-release-confidence.md) | 交付、审计及删除故障恢复验收 |

正式发布附件另见 [GitHub Releases](https://github.com/codexlin/UnoRAG/releases)。离线完整 clone 可用
`git show 6918b7596f77974cc036c15a3f3140aa89a95aef:docs/evidence/<文件名>` 读取；浅克隆须先获取该提交。

## 更新规则

1. 按 [发布流程](../RELEASE.md) 验收，并绑定真实 commit、镜像 digest、配置和环境。
2. 新发布报告取代当前报告时，在本索引为旧报告留下固定提交链接；历史文件不继续堆在当前树。
3. 阶段实验放入受限、忽略的本地产物或脱敏 issue；最终结论汇总到当前报告，不为每次重跑新增公开 MD。
4. 原始问题、回答、文档内容、凭据和日志不得随公开报告提交；失败不能删除或被重跑覆盖。
5. 提交前执行 `pnpm docs:check`，检查链接、报告索引和单份当前报告约束。

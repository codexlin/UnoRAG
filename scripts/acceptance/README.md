# UnoRAG 验收自动化

当前脚本只通过产品 HTTP 边界测试原生 TypeScript 运行时。Python FastAPI 时代的
恢复、升级、故障注入与 OCR 脚本已经退役。当前证据保存在 `docs/evidence/`，
但不能用于证明后续提交。

## 当前入口

| 脚本 | 覆盖 |
|---|---|
| `deploy/compose/scripts/pilot-preflight.sh` | TS core、Web 契约、类型与迁移静态门禁 |
| `deploy/compose/scripts/pilot-smoke.sh` | 登录、上传、Ask、Public API、replace、delete 全链路 |
| `scripts/acceptance/s1_s2_isolation.sh` | 多组织、多 Workspace、ACL 与 IDOR 零泄漏 |
| `scripts/acceptance/capacity_baseline.py` | Retrieve、Ask、生命周期阶梯并发与可选 MinerU 探针 |
| `scripts/acceptance/upgrade-rollback.mjs` | 四镜像 digest 升级、旧版应用回滚、再次升级与数据校验 |
| `scripts/acceptance/provider-faults.mjs` | 真实 Provider 透传基线、受控故障注入、失败替换保留旧版与恢复 |
| `scripts/acceptance/restore-drill.mjs` | 隔离实例备份、删卷、恢复、Ask 与生命周期校验 |
| `scripts/acceptance/release-gate.mjs` | 按绑定 commit / manifest 的 profile 串行执行发布门禁 |

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

## 发布演练与边界

升级回滚、Provider 故障和隔离恢复已有自动化入口，具体参数、显式授权开关及完整 profile 见
[RELEASE.md](../../docs/RELEASE.md)。先使用 `--plan` 检查目标，再在独立实例执行；不得在生产实例
运行破坏性恢复。脚本已有不代表新候选自动通过，必须保留本次运行的版本、环境与结果。

Provider 故障脚本使用可控代理注入 HTTP 状态和超时，先后验证真实上游透传与恢复；它不等于对
外部托管模型或 MinerU 服务执行真实重启。Worker / 数据服务停启仍需按部署环境另外演练。

本地对象存储的恢复演练包含文档备份；COS 模式只备份数据库、Qdrant 和对象存储边界说明，远端对象
仍留在原桶中，不能据此声称已经验证对象误删或桶级灾难恢复。客户容量、对象备份策略和 RPO/RTO
仍须分别验收并归档。

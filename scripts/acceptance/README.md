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

所有验收脚本使用一致退出码：`0` 通过，`1` 失败，`2` 因依赖或配置缺失而
阻塞。`2` 不能记为产品通过。

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

## 仍需自动化

TS-only RC 已手工完成独立恢复和依赖故障验收。仍需把以下发布动作固化成可重复自动化：

1. 四张 digest-pinned 镜像的升级与应用回滚。
2. 模型 Provider 与 ParserProvider 的重启/幂等故障注入。
3. 面向具体客户环境的容量和 RPO/RTO 报告归档。

独立 Compose backup/restore、PostgreSQL、DBOS worker 和 Qdrant 故障路径已有
2026-08-02 RC 证据，但仍不能替代最终发布镜像和目标客户环境的验收。

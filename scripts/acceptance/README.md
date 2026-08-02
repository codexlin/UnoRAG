# UnoRAG 验收自动化

当前脚本只通过产品 HTTP 边界测试原生 TypeScript 运行时。Python FastAPI 时代的
恢复、升级、故障注入与 OCR 脚本已经退役；历史结果仍保存在
`docs/acceptance/reports/`，但不能用于证明当前提交。

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

## 待重建

在 TS-only Docker 全栈验收稳定后，按新拓扑重建三类自动化：

1. 独立 Compose project 的 backup/restore 演练。
2. 四镜像升级与前向迁移后的应用镜像回滚。
3. DBOS worker、Qdrant、模型 Provider、ParserProvider 故障注入。

这些缺口在重建并真实执行前必须保持显式，不能用已删除的旧脚本代替。

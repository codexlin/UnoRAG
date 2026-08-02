# 试点验收 Runbook

目标：在绑定 commit、镜像 digest 和配置摘要的环境中，用真实工作负载形成
可复现的 **go / no-go** 结论。历史报告不能替代当前版本验收。

## 1. 前置

1. 按 [private-deployment.md](./private-deployment.md) 完成安装或升级。
2. 配置 `deploy/config/runtime.env`、`runtime.secret` 和 `bootstrap.env`。
3. 复制 [pilot-go-no-go-template.md](../acceptance/pilot-go-no-go-template.md)，
   记录 commit、四张镜像 digest、主机规格和外部 Provider。
4. 执行静态预检和全栈冒烟：

```bash
./deploy/compose/scripts/pilot-preflight.sh
cd deploy/compose
./scripts/pilot-smoke.sh
```

退出码：`0` 通过，`1` 失败，`2` 因依赖缺失而阻塞。`2` 不是通过。

## 2. 真实文件集

至少选择 Markdown、DOCX、文字 PDF；声明支持 OCR 时再加入扫描 PDF。每份文件
记录格式、大小、页数、表格特征、预期问题与预期引用。不得用虚构客户数据冒充
真实试点。

核心流程：

| 操作 | 期望 |
|---|---|
| 创建 library | 当前 workspace 可见，其他 workspace 不可见 |
| 上传 | `202` + job；最终 document `ready` |
| Ask/Retrieve | 有依据的答案携带可定位 citation |
| 替换 | 处理期间旧 active 可用；成功后原子切换 |
| 失败替换 | 旧 active 不被覆盖 |
| 删除 | 幂等；完成后不可召回 |
| Viewer 写操作 | `403` |

## 3. 隔离熔断

运行 [`../../scripts/acceptance/s1_s2_isolation.sh`](../../scripts/acceptance/s1_s2_isolation.sh)，
并在 UI 中用第二 workspace 抽检：跨 library、workspace、organization、restricted
group、未激活 generation 和已删除文档。任一越权召回或 citation 泄漏都强制
**NO-GO**。

## 4. 故障与恢复

当前 TypeScript/DBOS 拓扑的自动化故障脚本正在重建；在完成前按表手工执行并保存
日志，不得引用旧 Python worker 报告代替。

| 演练 | 操作 | 期望 |
|---|---|---|
| DBOS worker | 短暂停止 `dbos-worker` 后恢复 | workflow 可恢复，无重复 active |
| Qdrant | 短暂停止后恢复 | readiness 降级；恢复后 Ask/ingest 正常 |
| 模型 | 使用不可达测试 endpoint | 错误可定位；文档 active 不受影响 |
| Parser | MinerU 超时或不可达 | job 明确失败/重试；旧 active 可用 |

恢复后执行：

```bash
pnpm --dir apps/web lifecycle:inspect
curl -fsS "$UNORAG_BASE_URL/api/rag/health" | jq .
```

## 5. 备份、升级与容量

1. 按 [backup-restore-verification.md](../acceptance/backup-restore-verification.md)
   在可丢弃环境做一次 restore。
2. 运行 `backup.sh` 后执行 `upgrade.sh`，再跑全栈冒烟。
3. 用 [`../../scripts/acceptance/capacity_baseline.py`](../../scripts/acceptance/capacity_baseline.py)
   记录目标硬件的 P50/P95、错误率和安全并发预算。
4. 确认 dead/stuck workflow、磁盘、Postgres、Qdrant 和 Provider 失败有告警路径。

## 6. 签字条件

跨租户泄漏必须为 0；失败任务可定位；替换失败不影响旧 active；备份可恢复；
[production-ready-checklist.md](../acceptance/production-ready-checklist.md) 必选项有证据。
只有绑定当前版本的报告明确写出 **GO**，才允许对该部署声明 production-ready。

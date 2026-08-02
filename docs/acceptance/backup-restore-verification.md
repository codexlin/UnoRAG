# 备份 / 恢复验收清单

脚本：

- [`deploy/compose/scripts/backup.sh`](../../deploy/compose/scripts/backup.sh)
- [`deploy/compose/scripts/restore.sh`](../../deploy/compose/scripts/restore.sh)

Runbook：[`docs/runbooks/private-deployment.md`](../runbooks/private-deployment.md) §6。

## 1. 备份前准备

- [ ] 记录当前 git commit / 镜像 tag  
- [ ] 选择低峰或短暂停写窗口  
- [ ] 准备至少一份已激活文档（含已知 Ask 问题与期望 citation）  
- [ ] 记录对照值：`document_id`、`document_version_id`、`generation_id`、对象 `storage_key`、Ask 引用片段  

## 2. 执行备份

```bash
cd deploy/compose
./scripts/backup.sh ./backups/pilot-$(date +%Y%m%dT%H%M%S)
```

验收：

- [ ] 目录含 `postgres.sql`、`documents.tgz`、`qdrant.tgz`、`MANIFEST.txt`  
- [ ] `MANIFEST.txt` 中 `restore_order=postgres -> documents -> qdrant -> start apps`  
- [ ] `postgres.sql` 非空；`documents.tgz` / `qdrant.tgz` 大小合理（非 0）  

## 3. 破坏性验证（试点环境）

仅在可丢弃的试点/预发环境执行：

1. 额外上传一份临时文档（标记为「恢复后应消失」或记录其 id）。  
2. 可选：删除对照文档的 Qdrant 点或对象以制造不一致（高级演练）。  

或更安全：直接 restore 到同一环境覆盖，用对照文档验证一致性。

## 4. 恢复顺序（不得颠倒）

```text
1. 停止 app（web / dbos-worker / dbos-control / caddy）
2. 恢复 PostgreSQL
3. 恢复 document objects
4. 恢复 Qdrant
5. 启动 app（含 DBOS worker/control）→ readiness → 抽样 Ask
```

```bash
cd deploy/compose
CONFIRM=YES ./scripts/restore.sh ./backups/pilot-YYYYMMDDTHHMMSS
```

- [ ] 脚本按上述顺序执行完成  
- [ ] Redis 未从备份恢复（可重建；符合设计）  

## 5. 恢复后一致性

| 检查 | PASS? | 证据 |
|---|---|---|
| `GET /api/rag/health` → ok / ask_ready | | |
| 对照文档仍为 active，version/generation 与备份前一致 | | |
| 对象存储可读（替换/下载或 worker 可 reopen） | | |
| Ask 返回答案；citation 的 `document_version_id` 与对照一致 | | |
| ACL：无权限主体仍 404 / 无召回 | | |
| 备份后新增的「应消失」变更未保留（若做了破坏性步骤） | | |
| `pnpm lifecycle:inspect` 无异常 orphan 暴增 | | |

## 6. 失败判定

以下任一即 **FAIL**（备份项 NO-GO）：

- 恢复后 active pointer 与 Qdrant 可见 generation 不一致导致混答或空答且无法解释  
- citation 指向不存在的 version / 缺失对象  
- 跨租户数据在恢复后出现  
- 必须手工改库才能恢复服务  

## 7. 记录

将本清单结果粘贴或引用到
[`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md) §5（B1/B2）。

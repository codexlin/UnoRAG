# Private pilot on Aliyun — webch.cn（模拟真实用户）

> **状态：Conditional GO（已签字）** — 审批人 `codexlin`（授权代签 2026-07-28）。
> 本文 ≠ 通用生产 GA；机器为 2C/1.8Gi 单节点 Compose 试点。
> **告警 webhook（飞书等）明确暂缓**；备份 cron 已接通（见下）。

## 元数据

| 字段 | 值 |
|------|-----|
| 负责人 | codexlin |
| 环境 | 阿里云 ECS `dusty-ali` / `39.106.51.151` |
| 域名 | `https://webch.cn` · `https://www.webch.cn` |
| 产品 / 部署 SHA | `fa49d86` 基线；运行时 API 镜像含 302 国内改写（见本提交） |
| 拓扑 | Compose `unorag-webch` @ `/opt/unorag` |
| 边缘 | Caddy TLS（Let's Encrypt）；仅暴露 web |
| 试点日期 | 2026-07-28 |
| 报告作者 | agent（部署执行） |
| 审批 | Conditional GO · codexlin · 2026-07-28 |

## 验收结果

| ID | 检查项 | 结果 | 证据 |
|----|--------|------|------|
| D1 | 镜像 linux/amd64 构建并 `docker load` | PASS | `unorag-{web,web-migrator,api}:fa49d86`（后续 API 热修 tag `fa49d86-302cn`） |
| D2 | migrate / roles / bootstrap | PASS | admin=`codexlin@webch.cn` |
| D3 | 必需进程（含 outbox-worker） | PASS | 全 Up；api/web/lifecycle healthy |
| D4 | `GET https://webch.cn/api/rag/health` | PASS | `ask_ready=true` · `live_ready=true` |
| D5 | Let's Encrypt | PASS | `webch.cn` / `www.webch.cn` |
| D6–D7 | 登录页 + 管理员会话 | PASS | role=`owner` |
| D8 | `pilot-smoke`（HTTPS 真实上传→Ask→隔离→替换→删除） | PASS | `/tmp/unorag-webch-pilot-smoke.log` |
| D9 | 302 复杂 PDF（国内 `api.302ai.cn` + `file.302ai.cn` 改写） | PASS | `leave-scanned.pdf` / `mixed-charts.pdf` → completed · `302 云解析` |
| S6 | 浏览器不直连 FastAPI | PASS（设计） | 仅 Caddy:80/443 |
| B-cron | 每日备份 cron | PASS | 见 §备份 |
| Alerts | 飞书 / webhook | **DEFERRED** | 无正式飞书；书面暂缓 |
| Soak | 24–72h | SKIP | 按授权不做 |

## 已知限制（审批人已接受）

| # | 限制 | 处理 |
|---|------|------|
| 1 | 主机仅 **1.8 GiB RAM** | **接受** — 仅模拟试点；正式 GO 前升配 ≥4 GiB |
| 2 | 同机 openclaw :8443 等 | **接受** — UnoRAG 独占 80/443 |
| 3 | 告警 webhook **暂缓**；Resend 邮件已可作为 `ops/min_alerts` 通道 | **接受** — 飞书后置；邮件见 `ops/min_alerts/README.md` |
| 4 | 本环境未重跑完整故障矩阵/备份破坏性恢复 | **接受** — 继承本机 `29b06fe` 报告；日备已开 |
| 5 | 磁盘余量有限 | **接受** — 监控 `df`；大文档前扩容 |

## 备份

```cron
# /etc/cron.d/unorag-backup 或 root crontab
0 3 * * * cd /opt/unorag/deploy/compose && ./scripts/backup.sh ./backups/unorag-$(date +\%Y\%m\%d) >> /var/log/unorag-backup.log 2>&1
```

- 保留建议：本地 ≥7 天；负责人 codexlin
- 恢复：`CONFIRM=YES ./scripts/restore.sh ./backups/unorag-YYYYMMDD`

## 访问

- URL：https://webch.cn
- Admin：`codexlin@webch.cn`（密码仅存服务器 `bootstrap.env` / 本机 `/tmp/unorag-webch-admin-pass.txt`，**勿入库**）

## 运维命令

```bash
ssh dusty-ali
cd /opt/unorag/deploy/compose
source scripts/compose-env.sh
mk_compose -f docker-compose.webch.yml ps
```

## 审批人签字栏

| 字段 | 填写 |
|------|------|
| 结论 | **☑ Conditional GO**　☐ GO　☐ NO-GO |
| 审批人 | codexlin |
| 日期 | 2026-07-28 |
| 接受的限制编号 | 1–5（含告警暂缓） |
| 签名 / 确认 | codexlin（用户授权代签） |

### 结论

- [x] **Conditional GO** — 可在边界明确、有人值守下作模拟真实用户试点；告警暂缓。
- [ ] **GO** — 升配 + 正式告警接通后再勾。
- [ ] **NO-GO**

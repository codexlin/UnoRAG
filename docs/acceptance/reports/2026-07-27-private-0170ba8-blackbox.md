# Private stack black-box + stability slice — `0170ba8`

| 项 | 值 |
|----|----|
| 日期 | 2026-07-27 |
| 发布候选 SHA | `0170ba86dc7f83eba4789ebaef80b5ebbf0da24a` |
| 拓扑 | Compose `unorag-private` · `HTTP_PORT=8088` · 含 **outbox-worker** |
| 结论（本切片） | **Conditional PASS** — 真实上传黑盒与离线门禁绿；长 soak / 故障全矩阵 / TLS·告警签字仍待 |

## 1. 发布候选

- 已 push：`origin/main` @ `0170ba8`
- 镜像从该 SHA 构建：`web` / `api` / `migrate-web`（migrator 兼 outbox）

## 2. 栈就绪

| 服务 | 状态 |
|------|------|
| caddy / web / api | healthy |
| lifecycle-worker | healthy |
| **outbox-worker** | running（日志可见 `library.upsert` / `library.delete` completed） |
| postgres / qdrant / redis | healthy |
| `/api/rag/health` | `status=ok` · `ask_ready=true` · `qdrant_ok=true` |

首次 smoke 失败原因：存量库缺少 `parse_preference` 列。已 `migrate-web` 后恢复。

## 3. 真实黑盒（`pilot-smoke.sh`）

路径：登录 → 建库 A/B → **实际上传 markdown** → lifecycle 解析完成 → Ask → Public API v1（retrieve/ask/scope/revoke）→ 隔离 → 替换版本 → 删除。

| 步骤 | 结果 |
|------|------|
| health | PASS |
| login | PASS |
| create libraries + outbox 投影 | PASS |
| upload → `completed`（约 6s） | PASS |
| Ask + 引用 | PASS |
| Service Key Public API v1 | PASS |
| isolation | PASS |
| replace version | PASS（约 3s） |
| delete | PASS |
| **总体** | **`pilot-smoke PASS`** |

证据（本机）：`/tmp/unorag-private-stability-0170ba8/pilot-smoke.log`

## 4. 稳定性抽检（本轮已做）

| 项 | 结果 |
|----|------|
| lifecycle-worker 重启后 health | `ok` / `ask_ready` |
| outbox-worker 重启 | 进程恢复 |
| `private-stability.sh`（preflight + CI gate 36/36 + 合同测） | PASS |

## 5. 尚未覆盖（上线主线后续）

- Qdrant 暂停 / 模型不可用 / retry·cancel 故障矩阵
- 备份 → 销毁 → 恢复
- 生产 TLS、真实告警 webhook、值班与密钥轮换书面确认
- 24～72h soak（dead/stuck job、内存、磁盘、P95、模型错误率）
- 正式 go/no-go 签字稿

## 6. 操作提示

全新或落后迁移的卷：安装后务必 `mk_compose --profile migrate run --rm migrate-web`（及 rag migrate）。
日常启动：`mk_compose up -d caddy web api lifecycle-worker outbox-worker`。

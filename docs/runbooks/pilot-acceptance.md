# 试点验收 Runbook（L9）

目标：用真实（或客户书面同意的）工作负载验证产品承诺，形成版本化
**go / no-go**。配套模板与清单见 [`docs/acceptance/`](../acceptance/README.md)。

## 0. 前置

1. 按 [`private-deployment.md`](./private-deployment.md) 完成安装或升级。  
2. 填好 `deploy/compose/.env`（真实密钥与模型 endpoint；勿提交）。  
3. 复制 go/no-go 模板并填写元数据：  
   [`pilot-go-no-go-template.md`](../acceptance/pilot-go-no-go-template.md)。  
4. 跑离线预检（可在无 Compose 时执行）：

```bash
./deploy/compose/scripts/pilot-preflight.sh
# 退出 0=通过；2=依赖缺失跳过；1=失败（阻断）
```

5. Compose 已启动时跑冒烟：

```bash
cd deploy/compose
# 可选：export MERIKNOW_BASE_URL=http://localhost
./scripts/pilot-smoke.sh
```

## 1. 选择试点范围

- 1–2 个工作区（第二个用于跨 workspace 隔离）。  
- 代表性文件集：登记格式、大小、页数、表格比例、目标问题  
  （模板 §1；**禁止**虚构客户数据入库）。  
- 建议至少：1× Markdown、1× DOCX 或文本 PDF；有 OCR 需求再加扫描 PDF。

## 2. 权限与生命周期验收

按模板 §2 执行，关键路径：

| 步骤 | 操作 | 期望 |
|---|---|---|
| 登录 | `POST /api/auth/session` 或 UI | session cookie |
| 建库 | `POST /api/libraries` | 200 |
| 上传 | `POST /api/libraries/{id}/documents` multipart | **202** + `job_id` |
| 等待 | `GET /api/jobs/{jobId}` | `completed`；文档 `ready` |
| Ask | `POST /api/rag/v1/ask` | 答案 + citation |
| 替换 | `POST .../documents/{docId}/versions` | 202；期间旧答案可用 |
| 删除 | `DELETE .../documents/{docId}` | 202；清理后不可召回 |

Viewer 账号（若已配置）：上传/删除应 403。

失败恢复：制造可重试错误或使用 retry API；确认 `stage` / `error_code` 可见。

## 3. 跨租户 / 跨工作区隔离

### 3.1 自动化（必跑，可 SKIP 但须记录）

```bash
./deploy/compose/scripts/pilot-preflight.sh
```

覆盖：

- `apps/api/tests/test_access_scope.py`（Qdrant tenant/workspace/group）  
- L7 CI gate（`fuse` / `isolation` / 拒答硬熔断）  

### 3.2 运行时抽检（试点环境）

| 检查 | 做法 | 期望 |
|---|---|---|
| 跨 library | 库 A 上传唯一 token；在库 B Ask 该 token | 拒答或无 A 的 citation |
| 跨 workspace | 第二工作区会话 Ask 第一工作区 library_id | 404 / 空 / 无泄漏 |
| 跨 organization | 第二组织（若有）重复上项 | 零泄漏 |
| 未激活 | 替换进行中检索 | 仍只见旧 generation |
| 已删除 | 删除完成后 Ask | 不可召回 |

任一泄漏 → **强制 NO-GO**。

`pilot-smoke.sh` 在同工作区内做 **跨 library** 隔离抽检；跨 org 需操作员按上表手工完成。

## 4. 故障演练

| 演练 | 步骤 | 期望 |
|---|---|---|
| Worker drain | `docker compose stop lifecycle-worker` → 再 `up -d` | 当前步骤结束后退出；lease 可恢复 |
| Qdrant | 短暂 `stop qdrant` → 恢复 | health degraded → 恢复后 Ask/ingest 正常 |
| 模型 endpoint | 临时错误 key / 断网（仅模型） | Ask 失败可定位；active 文档不被破坏 |
| MinerU | 超时/429（若启用） | job retry/dead；旧 active 仍可用 |

完成后：`pnpm --dir apps/web lifecycle:inspect`（需正确 `DATABASE_URL`）。

## 5. 备份、升级、回滚、容量

1. 按 [`backup-restore-verification.md`](../acceptance/backup-restore-verification.md) 做 backup→restore。  
2. 升级：`./scripts/backup.sh` 后 `./scripts/upgrade.sh`；再跑 `pilot-smoke.sh`。  
3. 回滚：按 private-deployment §5；或书面确认镜像回滚计划。  
4. 容量：磁盘、Postgres、Qdrant、队列深度告警已接通，或在 go 报告中书面接受风险。

## 6. 支持边界、SLA/SLO、升级路径

在 go 报告 §8 固化：

**首版 SLO（可测量行为）**

```text
跨租户数据泄漏：0
已确认成功的写入不静默丢失
失败任务 100% 可定位到 stage/error_code
旧 active version 在替换失败时保持可用
dead/stuck/orphan 进入监控和运维队列
```

**问题升级路径（示例，按客户改）**

1. 操作员：`lifecycle:inspect` + job_id / request_id  
2. 应用负责人：对照 audit / 结构化日志  
3. 平台：Postgres / Qdrant / 对象存储 / 模型 endpoint  
4. 厂商支持：附 go 报告、gate JSON、compose 版本与 commit  

## 7. 形成结论

1. 填完 [`pilot-go-no-go-template.md`](../acceptance/pilot-go-no-go-template.md)。  
2. 勾选 [`production-ready-checklist.md`](../acceptance/production-ready-checklist.md)。  
3. 仅当结论为 **GO** 且清单允许时，才可宣称 production-ready。  

**仓库内 L9 文档与脚本就绪 ≠ 已获得客户/试点 GO。**

## 8. 供应链（SBOM）说明

L8/L9 不阻塞完整 SBOM 流水线。操作建议：

- Compose / Helm 已 pin 基础镜像 tag（见 `deploy/compose/env.example`）。  
- 客户交付前可自行对构建产物运行 `syft` / `trivy` 等并归档。  
- 未接入 CI 扫描时，必须写入已知限制，不得暗示「已完成镜像安全认证」。  

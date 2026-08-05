# Registry RC.6 平台合同与发布性能验收

## 结论

`v0.1.0-rc.6` 通过不可变发布、平台合同、镜像优化和 `rc.5 -> rc.6` 原地升级验收。官方
manifest 现在显式声明 `UNORAG_IMAGE_PLATFORM=linux/amd64`；Compose 安装和升级会在镜像拉取、
配置改写及维护窗口前 fail-closed 校验 Docker Engine 架构。

本报告继续限定为 `linux/amd64` 产品镜像功能验收。Apple Silicon 上的升级使用了只覆盖 UnoRAG
产品服务的 platform overlay，并显式传入本地验收开关，不构成生产 ARM 支持或容量结论。

## 版本绑定

| 项目 | 值 |
|---|---|
| Release | `v0.1.0-rc.6` |
| Git commit | `11655dc1154c4259` |
| Release run | [`31025765753`](https://github.com/codexlin/UnoRAG/actions/runs/31025765753) |
| Main CI run | [`31025166700`](https://github.com/codexlin/UnoRAG/actions/runs/31025166700) |
| DBOS application version | `unorag-11655dc1154c4259` |
| Image platform | `linux/amd64` |
| ACR manifest | [`releases/v0.1.0-rc.6/release-acr.env`](./releases/v0.1.0-rc.6/release-acr.env) |
| GHCR manifest | [`releases/v0.1.0-rc.6/release-ghcr.env`](./releases/v0.1.0-rc.6/release-ghcr.env) |

| 镜像 | Digest | RC.6 大小 | RC.5 大小 | 变化 |
|---|---|---:|---:|---:|
| Web | `sha256:b682d924b54002636c615adb7dc1a6a46b69b726ecb5c639ca91bcdcf9c65baa` | 97,506,114 | 97,506,313 | -199 |
| Migrator | `sha256:219b9c14b82224ffeb1dcd5a8a7c62fb2325e119385416a665c0ff3ee717da8b` | 110,749,262 | 110,749,199 | +63 |
| Ops | `sha256:2522b6aa3d4f1838289ed3a02d22ff8b0d850c853dd6bcc6c6d375b5f8ff87a2` | 257,600,133 | 290,598,361 | -32,998,228 (-11.4%) |
| Worker | `sha256:546144e96b163e83814522d6df561cec4dd8c4bd232db54fbdd5f45bc5e9740d` | 257,927,653 | 290,925,883 | -32,998,230 (-11.3%) |

ACR 与 GHCR manifest 引用相同 digest。四张 Trivy HIGH/CRITICAL 扫描均通过。

## 平台合同

- GitHub release workflow 和本地 release 工具均在 manifest 写入规范化平台。
- `install.sh --manifest` 和 `upgrade.sh --manifest` 在任何持久化改写或停机前校验 Docker Engine。
- `linux/arm64` Docker Engine 对 `linux/amd64` manifest 默认拒绝，并返回可操作错误。
- `--allow-platform-emulation` 必须显式提供；它只允许本地验收继续，不能静默改变基础设施架构。
- RC.5 及更早的历史 manifest 没有平台字段时，兼容路径明确警告并按其实际构建合同推断
  `linux/amd64`。
- 平台值会随镜像和 DBOS version 一起写入 runtime pins，并进入升级前一版本快照。

## 构建与运行时验证

旧 Ops/Worker Dockerfile 先安装完整依赖，再在后续 layer 执行 `pnpm prune --prod`；被删除的开发
依赖仍保留在镜像历史中。RC.6 使用独立 `runtime-deps` stage 直接安装生产依赖，并为四个目标设置
独立 GHA BuildKit cache scope。

- 首次 PR cache 建立后的 RC.6 发布用时 2 分 58 秒；RC.5 发布用时约 6 分 08 秒。
- 本地已用 `linux/amd64` 构建 Ops 与 Worker，而不是只检查 Dockerfile 文本。
- Worker 内成功加载 LiteParse、DBOS SDK、Qdrant Client、LangGraph 和 tsx。
- Ops 内成功加载 PostgreSQL 与 Drizzle runtime。
- 两张镜像仍以 UID `10001` 非 root 运行。

没有继续手工裁剪 Worker 依赖清单。当前 11% 收益来自修正 Docker layer 语义，风险较低；进一步
缩小需要编译 Worker bundle 或拆分 package 边界，应作为单独架构工作验证。

## 原地升级

隔离 Compose 项目 `unorag_rc_clean` 从 RC.5 digest 升级到 RC.6：

1. 平台不匹配先被识别，通过产品服务 overlay 与显式本地开关继续。
2. 旧应用任务和旧 DBOS workflow 均排空后才停止 Worker。
3. 向前迁移、最小权限角色校验、Worker/Control 切换、ACL 对账与生命周期巡检通过。
4. 完整 pilot smoke 通过上传、Ask、Public API Retrieve/Ask、Service Key scope 与撤销、跨文库
   隔离、replace 和 delete。
5. RC.5 创建的“Registry RC 验收库”和唯一 ready 文档在升级后仍存在；smoke 临时数据已清理。

最终 readiness 为 `degraded=false`，PostgreSQL、Qdrant、metadata 与 Ask 均 ready；生命周期为
`dead=0`、`stuck=0`、`deleting=0`、`cleanup_errors=0`、`pending_acl=0`。

## 后续

1. GitHub Actions 当前提示部分 action 仍以弃用的 Node 20 runtime 运行，应升级 action major 并复验。
2. 实施 tombstone 保留、批量清理、指标和告警，控制长期运行的数据增长。
3. 在客户等价 `linux/amd64` 主机执行容量、P50/P95 和恢复演练，才能形成目标环境 Production GO。

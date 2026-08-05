# Registry RC.5 不可变发布验收

## 结论

`v0.1.0-rc.5` 在本报告记录的环境和 `linux/amd64` 产品镜像范围内通过发布验收：四个产品镜像
由同一次 GitHub Actions 构建产生、经 Trivy 扫描后同时发布到 ACR 和 GHCR，并通过了从 digest
manifest 空环境安装、真实文件入库与浏览器问答、`rc.4 -> rc.5` 升级、`rc.5 -> rc.4` 应用
回滚以及再次升级。

本结果关闭了“源码能运行但发布物未经验证”的交付缺口，但不是跨架构认证或客户目标硬件上的容量
结论。正式上线仍需在目标 `linux/amd64` 主机执行安装、恢复和 SLO 验收。

## 版本绑定

| 项目 | 值 |
|---|---|
| Release | `v0.1.0-rc.5` |
| Git commit | `78445ab3261fa810` |
| GitHub Actions run | [`31018916075`](https://github.com/codexlin/UnoRAG/actions/runs/31018916075) |
| DBOS application version | `unorag-78445ab3261fa810` |
| ACR manifest | [`releases/v0.1.0-rc.5/release-acr.env`](./releases/v0.1.0-rc.5/release-acr.env) |
| GHCR manifest | [`releases/v0.1.0-rc.5/release-ghcr.env`](./releases/v0.1.0-rc.5/release-ghcr.env) |

镜像 digest：

| 镜像 | Digest | 大小 |
|---|---|---:|
| Web | `sha256:9f088fbb78aa76b61aa2bfd0c6d98c5989e12635e0bee841566499030fdcdf31` | 97,506,313 bytes |
| Migrator | `sha256:a6668f1b851e09da7455e66fb52dba92e299ba50af00e033fa54558c8a332929` | 110,749,199 bytes |
| Ops | `sha256:d2c7b23f6705a8ed1622357764438e70c8ea07636d2bbefb89f2aece29b7fb85` | 290,598,361 bytes |
| Worker | `sha256:d5608300cc20f2e266d062723500cf70c4458bd5e3c2cb33e50b518154e3e7b2` | 290,925,883 bytes |

ACR 与 GHCR manifest 引用相同的四个 digest。发布 workflow 的构建、双仓库推送和四个 Trivy
扫描均通过。首次 run `31017564542` 因 ACR Ops 镜像上传长时间无进展而取消；相同 commit 的
重跑成功。该事件不影响产物一致性，但说明 Registry 上传和构建缓存仍需优化。

## 验收环境

- 宿主机：Apple Silicon macOS，Docker Desktop。
- 产品镜像：发布产物仅提供 `linux/amd64`，本次通过每个产品服务的 Compose overlay 进行模拟运行。
- PostgreSQL、Qdrant、Redis 等基础设施镜像：宿主机原生架构。
- 隔离项目：`unorag_rc_clean`，独立端口 `8091` 和独立数据卷。
- 安装输入：仅使用发布 manifest 与必要运行时 Secret；未复用已有业务数据库、Qdrant collection
  或文档数据。

未把验收 overlay 纳入产品部署文件。生产环境不得依赖静默模拟；部署前应明确校验目标主机架构。

## 执行结果

### 发布物安装

- `install.sh --manifest` 从 ACR 拉取四个 digest 镜像，未触发本地构建。
- Drizzle migration、最小权限数据库角色、首个组织/Workspace/Admin bootstrap、DBOS 初始化、
  ACL 对账、生命周期巡检、Web 和 Caddy 启动全部通过。
- 缺失 digest、浮动 tag 或不完整 manifest 会被安装入口拒绝，发布物与源码 commit 可追溯。

### 真实文件与浏览器

在真实浏览器中创建“Registry RC 验收库”，上传仓库真实文件 `testdata/md/handbook.md`：

- 文档在约 1.18 秒后进入 `ready`，生成 7 个 chunks。
- 无证据问题“员工请假需要提前几个工作日提交申请？”被正确拒答。
- 问题“病假完整材料须在返岗后多久补交？”回答“返岗后三个工作日内补交”。
- 回答包含 2 条指向 handbook“第3章 请假制度”的 citations。

### 升级与回滚

1. 使用 `rc.4` digest manifest 完成空环境安装。
2. 执行 `rc.4 -> rc.5`：入口维护、应用任务与 DBOS workflow 双排空、向前迁移、角色校验、
   Worker/Control/Web 切换与生命周期巡检全部通过。
3. 官方 pilot smoke 通过：上传、Ask、Public API Retrieve/Ask、Service Key scope 与撤销、跨文库
   隔离、replace 和 delete。
4. 使用 `.upgrade-state/previous-images.env` 执行 `rc.5 -> rc.4` 应用回滚；数据库保持向前兼容，
   pilot smoke 再次通过。
5. 再次升级到 `rc.5`，原有 handbook 及引用在升级和回滚后均可继续使用。

### 最终状态

- Readiness：PostgreSQL、Qdrant、metadata、Ask 均 ready，`degraded=false`。
- 运行版本：Web 和 Worker 均为 ACR 中 `rc.5` 的精确 digest。
- DBOS Worker：`application_version=unorag-78445ab3261fa810`。
- 排空：业务任务与 DBOS workflow 均为 `drained=true`。
- 生命周期：`dead=0`、`stuck=0`、`deleting=0`、`cleanup_errors=0`、`pending_acl=0`。
- 最终业务数据：1 个文库、1 个文档、1 个 ready 文档。

## 未覆盖范围

- 未在客户目标 `linux/amd64` 主机测容量、P50/P95 或长时间稳定性。
- 未认证 `linux/arm64` 发布物；当前 workflow 也未生成 multi-arch manifest。
- 未执行生产数据库原地恢复；恢复能力沿用现有独立环境演练证据，客户上线仍需执行自己的恢复演练。
- 未把 ACR 上传偶发慢速视为产品功能失败，但它会影响发布时长，应持续观测并增加 Registry cache。

## 后续门槛

1. 在安装前显式校验并报告镜像/宿主机架构；当前发布策略先声明仅支持 `linux/amd64`。
2. 优化 Ops/Worker 镜像层和 BuildKit Registry cache，降低约 291 MB 镜像的重复上传与拉取成本。
3. 在目标部署硬件执行容量与 SLO 验收，再把 `rc.5` 结论提升为具体客户环境的 Production GO。
4. 补齐 tombstone 保留与清理策略，避免长期运行后生命周期数据无限增长。

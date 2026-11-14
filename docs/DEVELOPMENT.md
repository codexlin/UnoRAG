# UnoRAG 开发指南

UnoRAG 是一个根目录 TypeScript 应用：Next.js 提供产品与 HTTP 边界，DBOS Worker
执行持久化文档工作流。Python 不属于产品运行时，仅用于少量宿主机配置迁移、验收、
评分和测试数据生成脚本。

## 环境要求

- Node.js 22
- pnpm 9
- Docker 与 Docker Compose v2
- 可选：Helm 3，用于 Chart 校验
- 可选：Python 3，用于宿主机验收和测试数据工具

## 安装与检查

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:fast
pnpm test:contract
pnpm audit:prod
pnpm db:check
pnpm build
```

`pnpm test:fast` 覆盖不依赖外部服务的产品行为、授权、DocumentIR/TableIR、解析、切分、
检索过滤、Ask 图、DBOS 工作流及部署契约。`pnpm test:contract` 是公共 API、IR、检索和工作流
契约的聚焦子集，适合接口变更时快速确认。环境测试不会混入快速套件后以 skip 伪装通过。CI 会创建
临时 PostgreSQL、Qdrant 和 Redis，执行 Drizzle migration 与运行时角色初始化，再运行 0 skip 的
真实集成套件。
本地可用以下统一入口复现：

```bash
DATABASE_URL="$INTEGRATION_DATABASE_URL" pnpm db:migrate
INTEGRATION_DATABASE_URL=postgresql://... \
INTEGRATION_QDRANT_URL=http://127.0.0.1:6333 \
INTEGRATION_REDIS_URL=redis://127.0.0.1:6379/15 \
pnpm test:integration
```

浏览器测试面向已经安装好的候选版本，不隐式启动另一套应用或共享客户环境：

```bash
pnpm exec playwright install chromium
UNORAG_E2E_BASE_URL=http://127.0.0.1:8080 \
UNORAG_E2E_ADMIN_EMAIL=admin@unorag.local \
UNORAG_E2E_ADMIN_PASSWORD='...' \
pnpm test:e2e
```

重复执行浏览器套件也会消耗真实登录限流额度；优先在套件内复用会话。登录失败先检查 HTTP 429 和
`Retry-After`，不要将其归为页面导航故障，也不要为通过 UI 测试放宽正式阈值或清空整个 Redis。

测试按责任分层，而不是按版本复制：

| 层级 | 责任 | 默认入口 |
|---|---|---|
| Fast | 纯函数、领域服务、组件状态和结构化部署契约 | `pnpm test:fast` |
| Contract | 稳定公共 API、DocumentIR、检索与工作流接口 | `pnpm test:contract` |
| Integration | 显式列出的 PostgreSQL、Qdrant、Redis 真行为 | `pnpm test:integration` |
| E2E | 已运行候选版本的登录和桌面/移动端关键旅程 | `pnpm test:e2e` |
| Acceptance | 真实文件、权限隔离、故障与恢复 | 发布验收脚本 |
| Offline semantic | 可选 Python/Ragas 数据契约、隐私和预算；CI 使用模拟 HTTP，不调用付费模型 | 见 [EVALUATION.md](./EVALUATION.md#可选-ragas-离线语义评测) |

旧的 `pnpm test` 和 `pnpm test:ts-core` 暂时保留为兼容入口；新增或调整 CI 应使用分层入口。
测试应断言调用者可观察的状态、响应和副作用。只有不可执行的历史 migration 或发布清单才允许
静态契约检查，并应优先使用 SQL/YAML/Compose 解析器，不要锁定函数名、源码调用顺序或 CSS 类字符串。
数据库结构契约必须在 Integration 层查询迁移后的 `pg_catalog` / `information_schema`，验证实际列、约束、
外键、索引、触发器和角色权限。品牌资产、许可证清单、机器可读公共契约与版本化 fixture 本身就是交付物，
这类测试可以读取文件，但应验证结构、哈希或解析结果，而不是实现源码的排版。

`testdata/` 是版本化 fixture，不是测试输出。`testdata/ab/_e2e_out/`、`.next/`、`dist/` 和容量报告
是可再生成产物，保持在 `.gitignore` 中，不得提交。新增测试优先放入已有领域文件；只有职责或 fixture
明显独立时才新建文件，不以减少测试文件数量为目标合并无关安全边界。

该 PostgreSQL 登录必须能创建测试用 NOLOGIN 角色。只允许使用一次性或专用测试实例，不要指向客户库或
共享开发数据。

## 本地运行

完整生命周期开发复用私有部署 Compose 的配置、数据库、Qdrant、Redis 与文件存储：

```bash
cd deploy/compose
./scripts/init-config.sh
# 填写 ../config/runtime.env、runtime.secret；高级调优按需修改
./scripts/install.sh
```

已有上述环境后，从仓库根目录运行 `pnpm dev:full`，访问 `http://localhost:3001`。
该命令构建开发依赖镜像、停止旧应用进程、应用现有前向迁移，然后以本地源码启动 Web 热更新和
Worker/control 自动重启。数据库和文件不重置，Web/Worker 使用同一份代码与 `dev-local` 执行版本。
Linux 依赖与 Next 缓存分别使用 Docker 卷，不复用宿主机的原生模块。首次安装或依赖变化需要构建，
普通源码修改无需重建镜像。切换前应等待任务结束并备份；迁移拒绝未排空的入库任务时先处理任务，不绕过检查。

手机访问可使用
`UNORAG_DEV_BIND=0.0.0.0 UNORAG_DEV_ORIGINS=192.168.1.4 UNORAG_DEV_BASE_URL=http://192.168.1.4:3001 pnpm dev:full`。
沿用原开发账号和工作区，不创建另一套 UI 数据库；`pnpm dev:full logs` 查看应用日志，
`pnpm dev:full stop` 仅停止应用进程。开发覆盖文件不属于正式安装、升级或香港部署链路。
覆盖文件显式允许 `127.0.0.1` 的开发资源与 HMR；局域网 IP 则由上述变量按需加入，不能使用全开放白名单。

只调整页面时，可以单独启动本地基础设施和 Next.js：

```bash
docker compose up -d
cp -n .env.example .env.local
pnpm dev
```

上传、替换、重索引、ACL 投影、删除和清理依赖 DBOS system database、Worker 运行角色、
Qdrant、共享文档存储与模型配置，应使用完整 Compose 环境验证。

手机预览须连接同一可信局域网，并显式允许本机当前 IP，例如
`UNORAG_DEV_ORIGINS=192.168.1.4 pnpm dev --hostname 0.0.0.0`；多个主机名用逗号分隔，不含协议或端口。
这是 Next 开发资源的来源白名单，仅在开发模式读取，不改变生产 CSP、鉴权或 Cookie 规则。
不要对公网开放开发服务器；数据库、Redis 仍只绑定回环地址，实际 IP 变化后须重启预览。
HTTP IP 地址不是安全上下文，浏览器不提供 `crypto.randomUUID`；客户端临时 ID 统一通过
`src/lib/client-id.ts`，在该方法不可用时使用 `crypto.getRandomValues` 生成 UUID v4，不能改用
`Math.random`、时间戳或测试注入来掩盖预览故障。这不放宽正式部署的 HTTPS、鉴权或 Cookie 边界。

对源码热更新服务跑浏览器测试时，显式设置 `UNORAG_E2E_TARGET_MODE=development`。
该模式只调整开发/正式安全响应头的断言：开发允许 HMR 所需的 `unsafe-eval` 且不发送 HSTS；
默认仍验证正式候选版本的严格响应头，不能用开发模式替代发布安全验收，也不延长默认等待或增加重试。

## 仓库结构

```text
src/app/            页面与 Next.js Route Handlers
src/components/ui/  无业务语义的基础 UI
src/components/app/ 产品布局、跨页面展示及按功能聚合的 UI
  ask/              问答页面、流式尝试生命周期、turn reducer 与链路抽屉
  libraries/        知识库列表、文档台账、对话框与工作区头部
src/core/           与传输层解耦的 RAG 领域实现
src/db/             Drizzle schema 与数据库访问
src/lib/            浏览器 API client、query key、展示投影和共享类型
src/lib/server/     产品应用规则：身份、RBAC、Workspace、文档命令与授权
src/server/         RAG HTTP 适配、检索运行时、会话仓储与观测服务
src/worker/         DBOS workflow、调度、对账与控制循环
drizzle/            不可重写的 PostgreSQL 迁移历史
contracts/          运行时使用的机器可读公共契约
deploy/             Compose、Helm、镜像和数据库角色配置
scripts/            发布、验收与维护工具
tests/              产品契约和原生 RAG 测试
testdata/           代表性真实文件与拒绝格式 fixture
```

仓库保持单根 TypeScript package：可复用 RAG 算法放入 `src/core/`，Next.js 应用规则放入
`src/lib/server/`。当前没有已排期的 monorepo 迁移；只有模块形成独立构建边界或被多个 composition root
真实复用时才提取为 package，不按产品版本拆包，也不为目录整齐创建空包。历史讨论见
[ADR 历史决策](./adr/README.md#历史决策)，当前开源产品边界见
[ADR-0007](./adr/0007-fully-open-source-product-and-services.md)。

UI 组件源码由仓库维护，不依赖 shadcn CLI 参与安装或构建。Base UI 状态变体与滚动条工具保存在
`src/app/ui-variants.css`，来源及 MIT 声明见 `NOTICE`。新增组件时须审核所需样式，不为生成代码
永久安装整套 CLI。第三方许可证仍按 pnpm 生产依赖清单、包内许可证及 SPDX 正文生成；无法确定的
许可文本会阻断检查，不静默跳过。

### 产品界面与动效

改动页面、组件、文案或交互前先读 [产品设计规范](./DESIGN.md)。它描述已确认的目标设计，不表示全站
已经改版；新旧样式交接按其中的小批顺序实施，不把演示稿作为服务端状态或计量契约。

优先复用现有 Base UI 与本地 UI 组件，简单反馈使用 CSS，需要状态协调时才使用 `motion/react`。
Sonner、Lucide 和阶段瀑布也沿用现有实现；不要为视觉打磨增加整套 registry 或第二个动画框架。
UI 改动须覆盖浅深色、键盘/触屏、reduced-motion 及相关真实状态；具体尺寸、节奏与验收项只维护在
设计规范中，不在本指南复制另一份数值表。

替换页面前按设计规范中的“现有能力与最终页面对应”核对入口、动作和实际 API 字段。简化原型不是
删减功能的依据；纯呈现、交互状态变化与新增数据契约分别审查，不把新能力混入换肤提交。

### 代码放在哪里

按现有职责扩展，不新增与 `lib/server` / `server` 平行的 `services`、`managers` 或通用 `utils` 层：

| 变更 | 首选位置 | 边界 |
|---|---|---|
| 页面/HTTP 接入 | `src/app/` | 组装和授权入口；可复用逻辑留在对应领域 |
| 问答交互和流式状态 | `src/components/app/ask/` | 同一功能内就近维护；不持有服务端凭据或业务权限事实 |
| 多页面复用展示 | `src/components/app/` | 例如引用卡片和 Markdown 渲染同时服务 Ask/归档，不塞入单一页面目录 |
| 客户端服务端状态 | `src/hooks/`、`src/lib/query-*`、`src/lib/api.ts` | 保持 Workspace query scope；不复制第二份全局业务状态 |
| 产品权限/版本命令 | `src/lib/server/` | 鉴权、事务和业务规则，不导入 UI |
| RAG 算法/契约 | `src/core/` | 解析、IR、切分、检索、Ask 节点；不持有浏览器 Session |
| RAG 接入与持久化适配 | `src/server/` | 解析可信 scope、组装 core、写请求/会话记录；不是第二个独立后端 |
| 后台生命周期 | `src/worker/` | DBOS 执行、对账、激活和清理；不接管用户管理 |

- 文件名使用 `kebab-case`，React 导出使用 `PascalCase`；直接导入具体模块，不为目录美观新增全量 barrel。
- 同一功能的组件、状态 reducer 和异步协调器就近放置；基础 UI 与跨页面组件保持独立。
- 移动文件同步更新全部调用者和测试，不保留没有消费者的转发文件。路径调整与行为修改分开审查。
- 新增领域代码优先 TypeScript；现存 `.mjs` / `.d.mts` 的运行和测试契约先验证再迁移，不一次性改后缀。
- 拆大文件按职责与可测试边界进行，不按固定行数机械拆散。当前 Ask handler/runtime、删除 ports、
  `src/lib/api.ts` 等仍有较大模块；UI 归类不代表这些模块已完成重构，涉及它们时单独处理。

Ask 后端保持在 `src/server/http/ask/` 内：`native-handler.ts` 负责 HTTP/SSE 编排及授权检查点，
`run-diagnostics.ts` 负责请求账本和安全诊断投影，`native-runtime.ts` 组装图与授权检索，
`table-runtime.ts` 承接表格计划和确定性执行。表格模型调用继续使用同一授权检查点和取消信号，
诊断模块不反向依赖 handler，也不改变请求的结算时机。

### 新人阅读两条链路

1. 问答：`src/app/app/ask/page.tsx` → `src/components/app/ask/ask-workspace.tsx` → `src/lib/api.ts`
   → `src/app/api/rag/[...path]/route.ts` → `src/server/http/ask/` → `src/core/ask-graph/`。
2. 入库：`src/app/api/libraries/[libraryId]/documents/route.ts` → `src/lib/server/document-lifecycle.ts`
   → `src/worker/dispatcher.ts` / `workflows.ts` → parsing、ingest → 校验和激活事务。

先跟一条用户操作理解依赖，遇到权限/生命周期规则再查看 [架构](./ARCHITECTURE.md)，不必逐目录通读。

### 数据与产物的保留边界

| 内容 | 处理方式 |
|---|---|
| `drizzle/`、`contracts/`、版本化 `testdata/` | 保留；不是旧缓存，不因文件多而删 |
| `tests/`、评测 runner | 保留行为/权限/恢复覆盖；按领域维护，不用合并文件替代消除重复断言 |
| `.next/`、`dist/`、`*.tsbuildinfo` | 可再生成构建产物；确认无运行进程依赖后才清理 |
| `test-results/`、本地评测输出 | 先归档失败证据，再按保留策略清理；不是自动删除全部历史 |
| `.unorag/`、`deploy/config/` 实际配置、备份和 COS | 可能含凭据或业务数据；不能使用全局 `git clean -fdx` 当作项目整理 |

目录移动也需本地回归；新提交不能继承旧镜像的部署验收结论。

## 必须保持的约束

- PostgreSQL `app` schema 是唯一业务事实源。
- 所有新文档生命周期任务使用 DBOS，且 `workflow_id = job_id`。
- Qdrant 查询必须使用服务端解析出的 organization、workspace、ACL、document 和 active generation 过滤。
- ParserProvider 只返回 DocumentIR，不写产品数据库。
- 新 generation 验证通过后才能激活；失败替换不得影响旧版本。
- 浏览器和 Service Key 请求只进入 Next.js；Worker、数据库和向量库不对公网开放。

## 数据库修改

修改 `src/db/schema.ts` 后生成并检查前向迁移：

```bash
pnpm db:generate
pnpm db:check
```

发布后的迁移和 snapshot 不得重写。涉及运行时淘汰、数据所有权或已有行语义的迁移，必须
增加显式 preflight 和升级测试。

## 有意保留的兼容代码

- `/api/rag/*` 是 Workspace 的同源接口与健康边界，不是 FastAPI 代理。
- `legacy-sse.ts` 维持当前 Workspace SSE 事件契约。
- 旧 Ask 数值设置由 `0026_migrate_ask_profiles.sql` 一次性转换；运行时只读取业务 profile。
- PyMuPDF 标签只用于展示历史 `parser_report`；新 PDF 使用 LiteParse 或 MinerU。
- `init-config.sh` 负责升级时迁移或移除已经退役的环境变量。
- 历史 Drizzle 迁移即使包含旧 outbox/Python 名称也必须保持不变。

## 提交前

```bash
just check
source deploy/compose/scripts/compose-env.sh
mk_compose config >/tmp/unorag-compose.yml
helm lint deploy/helm/unorag --set config.llmBaseUrl=http://llm
git diff --check
```

功能完成不等于可发布。候选版本还要按 [RELEASE.md](./RELEASE.md) 完成真实文件、浏览器、
隔离、故障恢复和版本绑定验收。

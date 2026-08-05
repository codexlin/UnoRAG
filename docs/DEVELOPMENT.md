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
pnpm test
pnpm test:ts-core
pnpm typecheck
pnpm lint
pnpm audit:prod
pnpm db:check
pnpm build
```

`pnpm test` 覆盖产品、授权、HTTP、数据库和部署契约；`pnpm test:ts-core` 覆盖
DocumentIR/TableIR、解析、切分、检索过滤、Qdrant 投影、Ask 图、DBOS 工作流及失败语义。
依赖真实 PostgreSQL 或 Qdrant 的用例可以在纯本地检查中跳过，但发布验收不能把跳过记为通过。
CI 会创建临时 PostgreSQL、执行 Drizzle migration，并真实运行文档 replace/reindex 共享事务测试；本地
可通过 `DOCUMENT_VERSION_COMMAND_TEST_DATABASE_URL` 指向已迁移的隔离测试库复现。不要使用客户库或
共享开发数据执行环境依赖测试。

## 本地运行

完整生命周期开发优先使用私有部署 Compose：

```bash
cd deploy/compose
./scripts/init-config.sh
# 填写 ../config/runtime.env、runtime.secret、bootstrap.env
./scripts/install.sh
```

只调整页面时，可以单独启动本地基础设施和 Next.js：

```bash
docker compose up -d
cp -n .env.example .env.local
pnpm dev
```

上传、替换、重索引、ACL 投影、删除和清理依赖 DBOS system database、Worker 运行角色、
Qdrant、共享文档存储与模型配置，应使用完整 Compose 环境验证。

## 仓库结构

```text
src/app/            页面与 Next.js Route Handlers
src/components/     产品 UI 与可复用组件
src/core/           与传输层解耦的 RAG 领域实现
src/db/             Drizzle schema 与数据库访问
src/lib/server/     身份、RBAC、Workspace 与应用服务
src/server/         HTTP / 应用适配器
src/worker/         DBOS workflow、调度、对账与控制循环
drizzle/            不可重写的 PostgreSQL 迁移历史
contracts/          运行时使用的机器可读公共契约
deploy/             Compose、Helm、镜像和数据库角色配置
scripts/            发布、验收与维护工具
tests/              产品契约和原生 RAG 测试
testdata/           代表性真实文件与拒绝格式 fixture
```

当前根包阶段，可复用 RAG 算法放入 `src/core/`，Next.js 应用规则放入 `src/lib/server/`。
后续按 [ADR-0006](./adr/0006-private-product-monorepo.md) 与
[ADR-0007](./adr/0007-fully-open-source-product-and-services.md) 渐进迁移为 Product Monorepo；只有能
形成可执行依赖边界或被多个 composition root 使用的模块才提取为 package，不按商业版本拆包，也不为
目录整齐创建空包。

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
- 旧 Ask 设置迁移在首个 TS-only 升级窗口内继续读取历史客户配置。
- PyMuPDF 标签只用于展示历史 `parser_report`；新 PDF 使用 LiteParse 或 MinerU。
- `init-config.sh` 负责升级时迁移或移除已经退役的环境变量。
- 历史 Drizzle 迁移即使包含旧 outbox/Python 名称也必须保持不变。

## 提交前

```bash
just check
source deploy/compose/scripts/compose-env.sh
mk_compose config >/tmp/unorag-compose.yml
helm lint deploy/helm/unorag --set config.openaiBaseUrl=http://llm
git diff --check
```

功能完成不等于可发布。候选版本还要按 [RELEASE.md](./RELEASE.md) 完成真实文件、浏览器、
隔离、故障恢复和版本绑定验收。

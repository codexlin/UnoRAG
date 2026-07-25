# MeriKnow Control Plane（控制面）

Next.js 是浏览器侧产品服务：身份、工作区、ACL、文档版本、Job、审计（PostgreSQL schema `app`）。FastAPI 仍是内部 RAG 数据面。

产品定位与双模式见 [`docs/PRODUCT.md`](../../docs/PRODUCT.md)；本地联调总入口 [`docs/DEV.md`](../../docs/DEV.md)。

## 本地启动

```bash
cp -n .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:bootstrap
pnpm outbox:run &   # 文库投影到 RAG API
pnpm dev
```

打开 <http://localhost:3000/app>。浏览器走同源 `/api/rag/*` → `RAG_API_URL`。  
登录：`MERIKNOW_ADMIN_EMAIL` / `MERIKNOW_ADMIN_PASSWORD`。

产品上传走原生文档 API（默认 Lifecycle V2），**不**再代理 FastAPI ingest。需同时运行 api 的 `lifecycle_worker`，并与本进程共享 `DOCUMENT_STORAGE_ROOT`。

### 工作区邀请

Owner/admin 在 **设置** 中邀请。主路径为可复制 magic link（`/invite?token=…`，7 天、一次性）。可选 Resend 发信：

```bash
EMAIL_PROVIDER=none          # 默认：仅复制链接
# EMAIL_PROVIDER=resend
# RESEND_API_KEY=re_...
# EMAIL_FROM=MeriKnow <onboarding@your-domain.com>
# APP_BASE_URL=http://localhost:3000
```

角色：`viewer` | `editor` | `admin`（非 `owner`）。OIDC SSO 后置。

## 数据库

```bash
pnpm db:generate  # 改 schema.ts 后生成待审 SQL
pnpm db:check
pnpm db:migrate
pnpm db:studio
```

Drizzle **只**管理 schema `app`。不要指向 Python 的 `public` 兼容表。

## 环境变量

见 [`.env.example`](./.env.example)。

| 要点 | 说明 |
|------|------|
| `MERIKNOW_INTERNAL_SECRET` | = FastAPI `INTERNAL_AUTH_SECRET` |
| `MERIKNOW_SESSION_SECRET` | 独立；≥32；≠ internal |
| `DOCUMENT_LIFECYCLE_V2` | 默认开；仅显式 `false`/`0` 关闭 |
| Ask 产品旋钮 | `/app/settings` 工作区覆盖，不在 web env |

`INTERNAL_AUTH_ENABLED=true`（api）时多用户才不会档案串台。生产勿暴露 FastAPI。

Bootstrap UUID（`MERIKNOW_ORGANIZATION_ID` 等）为私有化种子，直至 OIDC 替换。`pnpm db:bootstrap` 幂等；已有密码凭证不会被静默重置。

## Outbox 投影

文库变更事务写入 `app.outbox_events`。每个部署至少跑一个：

```bash
pnpm outbox:run
```

升级后补偿：

```bash
pnpm outbox:reconcile
pnpm outbox:once
pnpm outbox:check
```

浏览器 BFF 拒绝 `/v1/internal/*`；仅 service HMAC 可调投影端点。详见 [ADR-0004](../../docs/adr/0004-nextjs-control-plane.md)。

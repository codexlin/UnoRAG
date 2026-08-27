# UnoRAG 身份认证与企业 SSO

UnoRAG 的认证和授权是两层独立边界：OIDC 或本地密码确认“用户是谁”，PostgreSQL 中的
Organization、Workspace membership、role、group 与 document ACL 决定“用户能访问什么”。来自 IdP 的
浏览器参数、邮箱或组声明不会直接进入 Qdrant 过滤条件。

## 支持的登录方式

| 方式 | 用途 | 默认状态 |
|---|---|---|
| 本地账号 | 首次安装、离线环境、恢复管理员 | 启用，作为 break-glass 路径保留 |
| 通用 OIDC | Keycloak、Entra ID、Okta、Authentik 等企业 IdP | 显式配置后启用 |

OIDC 使用 Authorization Code Flow、PKCE S256、`state` 和 `nonce`。发现文档、授权端点、Token Endpoint、
签名密钥和 ID Token 校验由 `openid-client` 处理。UnoRAG 只在一次性 HttpOnly Cookie、回调地址和协议校验
全部通过后签发自己的 8 小时 Session Cookie；访问令牌和刷新令牌不写入浏览器 Session 或业务数据库。

## 首次登录规则

OIDC 首次登录是 fail-closed 的。满足以下任一条件才会建立身份绑定：

1. 该 `(organization, issuer, subject)` 已绑定到一个 active 用户；
2. IdP 返回可信邮箱，且 Organization 内恰好有一个同邮箱 active 用户；
3. IdP 返回可信邮箱，且该邮箱存在未过期的 Workspace 邀请。

第三种情况会创建用户、接受对应邀请并建立 Workspace membership。没有邀请的陌生账号、重复邮箱、禁用
用户、失效邀请和没有 active Workspace 的用户都会被拒绝。外部身份保存在独立 `auth_identities` 表，因此
绑定 OIDC 不会覆盖本地管理员凭据。

默认只接受 `email_verified=true` 的邮箱。若受信任的企业 IdP 不提供该声明，但其 email claim 本身由目录
管理员保证，可以显式设置 `OIDC_TRUST_EMAIL_CLAIM=true`。这是一项部署级信任决定，不应由 Workspace 用户
在产品界面修改。

## Compose 配置

先在 IdP 注册 confidential Web client，并登记唯一回调地址：

```text
https://kb.example.com/api/auth/oidc/callback
```

在 `deploy/config/runtime.env` 写入非敏感配置：

```dotenv
LOCAL_AUTH_ENABLED=true
OIDC_ENABLED=true
APP_BASE_URL=https://kb.example.com
OIDC_ISSUER_URL=https://id.example.com/realms/acme
OIDC_CLIENT_ID=unorag
OIDC_CLIENT_AUTH_METHOD=client_secret_post
OIDC_SCOPES=openid profile email
OIDC_BUTTON_LABEL=使用企业账号登录
OIDC_TRUST_EMAIL_CLAIM=false
OIDC_ORGANIZATION_ID=00000000-0000-4000-8000-000000000001
```

`OIDC_ORGANIZATION_ID` 必须与该部署 `bootstrap.env` 中创建的 Organization ID 一致；运行期使用独立键是为了
不把包含管理员密码的 bootstrap 文件注入长期运行的 Web 容器。

在权限为 `0600` 的 `deploy/config/runtime.secret` 写入：

```dotenv
OIDC_CLIENT_SECRET=replace-with-idp-client-secret
```

生产 OIDC 的 `APP_BASE_URL` 和 `OIDC_ISSUER_URL` 必须使用 HTTPS。`APP_BASE_URL` 必须是浏览器实际访问的
固定公网 origin，不能使用容器内地址。修改后按正常升级流程执行 migration 并滚动 Web：

```bash
cd deploy/compose
./scripts/upgrade.sh
```

登录入口为 `/login`。可在服务器日志中检索 `auth.oidc.start_failed` 和
`auth.oidc.callback_failed`；结构化日志只记录稳定事件和错误类型，不记录 code、Token、Cookie 或用户正文。

## Helm 配置

Secret 增加 `OIDC_CLIENT_SECRET`，并设置：

```yaml
auth:
  appBaseUrl: https://kb.example.com
  organizationId: 00000000-0000-4000-8000-000000000001
  localEnabled: true
  oidc:
    enabled: true
    issuerUrl: https://id.example.com/realms/acme
    clientId: unorag
    clientAuthMethod: client_secret_post
    scopes: openid profile email
    buttonLabel: 使用企业账号登录
    trustEmailClaim: false
```

Chart 会拒绝“本地与 OIDC 都关闭”以及 OIDC 缺少公网 origin、Issuer 或 Client ID 的配置。

## 恢复与回退

- 至少保留一个受控本地 Organization owner，并通过 `rotate-admin-password.sh` 定期轮换；
- 本地恢复凭据进入客户密码库，不共享给普通成员，不依赖 IdP 可用性；
- IdP 故障时保持 `LOCAL_AUTH_ENABLED=true`，管理员可从同一 `/login` 页面进入；
- 禁用 OIDC 不删除身份绑定、用户、Workspace membership 或 ACL，重新启用后可继续使用原绑定；
- 删除/禁用用户和调整角色必须在 UnoRAG 权威数据面执行，现有 Session 的下一次请求会重新 hydrate 身份。

## 当前边界

- 已实现通用单 Issuer OIDC 登录、邀请式 JIT、现有账号安全绑定和认证来源会话保持；
- 尚未实现 IdP RP-Initiated Logout、SCIM、用户组声明映射、目录同步和多 Issuer 管理 UI；
- IdP 组不能绕过 UnoRAG group/document ACL。后续同步也必须先投影到 PostgreSQL，再沿既有 ACL 投影流程收敛；
- 每个客户独立部署仍是默认交付方式，OIDC 不是把产品改造成公网共享多租户 SaaS。

# webch UnoRAG 全新基线重置验收

> 日期：2026-07-30（UTC+8）
>
> 环境：`https://webch.cn`，阿里云 Docker Compose
>
> 绑定提交：`47b88f3`

## 结论

webch 已从旧运行栈重置为全新的 UnoRAG 预发布环境。重置前完成 PostgreSQL、
document storage 与 Qdrant 备份及校验；重置后迁移、bootstrap、健康检查和真实
HTTPS 纵向冒烟均通过。验收结束时 lifecycle 巡检为
`dead=0`、`stuck=0`、`cleanup_errors=0`。

本报告证明绑定版本在 webch 预发布拓扑可运行，不代表任意客户规格下的生产 SLA。

## 重置范围

| 项 | 结果 |
|---|---|
| 重置前备份 | PASS：PostgreSQL、documents、Qdrant 均生成非空归档并校验 SHA-256 |
| 旧 Compose 栈 | PASS：旧容器、网络与数据卷已停止并移除 |
| 新基础设施 | PASS：PostgreSQL、Qdrant、Redis 使用全新 UnoRAG project 与 volume |
| 数据库身份 | PASS：数据库名、用户与五个运行角色按 UnoRAG 配置重新初始化 |
| 数据迁移 | PASS：Web、RAG metadata migration 与运行角色权限断言通过 |
| 私有部署 bootstrap | PASS：organization、初始 workspace 与 admin 幂等创建 |
| 应用启动 | PASS：web、api、lifecycle、outbox、Caddy 全部健康 |
| 旧运行标识 | PASS：运行容器、volume、新部署目录中无旧品牌标识 |
| 旧源码 | PASS：从旧运行路径移出，保留在带日期的备份目录 |

## 真实 HTTPS 纵向冒烟

`deploy/compose/scripts/pilot-smoke.sh` 在公网入口完成：

1. admin 登录；
2. 创建两个 Library；
3. 上传 Markdown 并等待 ingest 完成；
4. Ask 命中唯一标记；
5. 创建、调用、限权与吊销 Service Key；
6. 跨 Library 隔离；
7. replace 新版本并等待原子激活；
8. delete 并等待 cleanup 完成。

结果为 **PASS**。Public Retrieve/Ask v1 均返回 citation，越权 Library、算法覆盖、
scope 与吊销反测均按契约拒绝。

## 运行态

新项目的运行资源统一使用：

- Compose project：`unorag-webch`
- PostgreSQL database/user：`unorag`
- Qdrant collection：`unorag_chunks`
- 源码目录：`/opt/unorag`

巡检结果：

```text
dead_jobs=0
stuck_jobs=0
deleting_documents=0
cleanup_errors=0
libraries_deleting_or_deleted=0
```

## 浏览器复验边界

本轮自动化能够通过真实浏览器打开 `https://webch.cn/login`，页面标题、邮箱、
密码与登录控件均正常渲染。后续交互因 Codex 浏览器控制通道持续网络超时而未完成，
因此本报告不把本轮 UI 点击流程标记为 PASS。

UI 的完整真实浏览器基线仍由
[`2026-07-29-webch-preproduction-baseline.md`](./2026-07-29-webch-preproduction-baseline.md)
提供；本轮同一 Web 构建还通过了 production build、146 项 Web tests，以及公网
API/BFF 纵向冒烟。

## 代码门禁

- API：`394 passed, 9 skipped`
- Web：`143 passed, 3 skipped, 0 failed`
- Next.js production build：PASS
- Biome：PASS
- `git diff --check`：PASS
- 受版本控制文件中的旧品牌文本：0

## 回滚与保留

重置前备份保存在 `/opt/backups/unorag-pre-reset-20260730`。旧源码保存在独立的
带日期备份目录。它们仅用于事故追溯或人工恢复，不属于当前运行路径。

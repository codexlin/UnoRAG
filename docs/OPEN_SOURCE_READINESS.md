# UnoRAG 开源发布准备审计

> 审计日期：2026-08-06
>
> 审计对象：`main`，从仓库创建至 `1dbb37a` 的 290 个提交
>
> 当前结论：**尚不可切换为 Public；代码安全扫描通过，许可与权属仍有发布阻断项。**

本文件记录公开仓库前的事实与门禁，不代替律师意见，也不因为写下“拟采用 Apache-2.0”而授予许可。
产品开源决策见 [ADR-0007](./adr/0007-fully-open-source-product-and-services.md)。

## 已完成

| 检查 | 结果 | 证据 |
|---|---|---|
| 当前跟踪树密钥扫描 | PASS | Gitleaks 8.30.1 扫描 Git archive，0 命中 |
| 完整 Git 历史密钥扫描 | PASS with reviewed exception | 290 commits；唯一命中是已删除 Python 脱敏测试中的密码 fixture，已按 commit/path/rule/line 精确 allowlist |
| 当前树内部环境检索 | PASS | 未发现真实密钥、客户数据、私钥或本机绝对路径；本地和 Compose 示例地址不计入泄漏 |
| 敏感本地产物隔离 | PASS | `.env*`、运行密钥、备份、验收输出、`.next`、`node_modules` 和本地文档存储均被忽略 |
| 自动防回归 | PASS | CI 全历史 Gitleaks；PR 模板要求隐私与来源确认 |
| 依赖许可证清点 | REVIEWED | 生产依赖共 379 个 package entries、14 种许可证表达式；CI 拒绝未经审阅的表达式漂移 |

历史扫描例外只覆盖以下指纹：

```text
46eb2f489df81f41fa825358f10f187d5592e37b:apps/api/tests/test_internal_context.py:generic-api-key:355
```

扩大文件、规则或 commit 范围的豁免不应合并。若扫描出现新命中，应先确认并轮换真实凭据，不得用
allowlist 让 CI 变绿。

## 发布阻断项

### 1. 主许可证与版权主体

- 尚未提交 `LICENSE`，因此当前仓库不是已授权的开源项目。
- Apache-2.0 是候选方案；项目所有者仍须确认版权主体、贡献归属和最终许可证。
- 确认后再加入完整许可证文本，并在 `package.json`、README 和镜像标签中保持一致。

### 2. 第三方通知与镜像内容

生产依赖清点包含 MIT、Apache-2.0、BSD、ISC、OFL-1.1、CC-BY-4.0，以及需要单独审阅的
`LGPL-3.0-or-later` libvips 二进制。该二进制由 Next.js 的 Sharp 依赖引入。公开发布镜像前必须：

1. 为实际进入每个镜像的依赖生成 SBOM；
2. 生成并随源码和镜像分发第三方许可证/NOTICE；
3. 核对 Sharp/libvips 的动态链接、修改、源码获取与通知义务；
4. 确保字体包的 OFL 文本和 caniuse-lite 的 CC-BY-4.0 归属进入分发材料。

不能仅凭 `pnpm licenses list` 的名称判断已经履行再分发义务。

### 3. 素材与测试 fixture 来源确认

下列内容未发现嵌入作者、组织或下载来源元数据，仓库历史显示它们由本项目加入，但仍需要项目所有者
书面确认“自行创作、生成或有权再许可”：

- `public/brand/`、favicon 与 Apple touch icon；
- `public/landing-evidence-desk.png`；
- `public/product-library-workbench.png`；
- `testdata/` 下 PDF、DOCX、图片化扫描件、文本和黄金集。

确认后应建立 `ASSETS.md`，逐组记录来源、作者/生成方式、许可证和是否允许修改。不能确认的素材必须在
公开前替换或删除。测试文件为合成内容也应明确记录，避免未来被误认为客户文档。

### 4. 公开历史策略

现有历史没有扫描到生产密钥，但包含旧品牌、已退役架构、预发布环境名称、个人邮箱和私有交付过程。
推荐为第一次公开发布创建**经审阅的干净初始历史**，保留当前私有仓库作为内部审计档案；不建议直接
改写正在使用的私有 `main`。若选择公开完整历史，项目所有者必须明确接受这些元数据永久公开，并再次
扫描所有 refs、tag 和 release asset。

### 5. GitHub 发布设置

公开前还需完成：

- 启用 GitHub Private Vulnerability Reporting，并验证 `SECURITY.md` 中的入口；
- 配置分支保护、必需 CI、Dependabot/Renovate 和最小权限 Actions；
- 建立维护者与安全响应渠道，替换临时的个人联系路径；
- 确认 GHCR 镜像公开权限、签名、SBOM、provenance 和不可变 tag 策略；
- 决定 ACR 仅作为镜像镜像站，还是从公开文档中移除个人 Registry 证据。

## 建议发布顺序

1. 项目所有者确认版权主体、许可证和素材/fixture 权属。
2. 生成源码与四个运行镜像的 SBOM、第三方通知和许可证包。
3. 在隔离分支建立候选公开树，移除私有验收残留并再次运行全历史/当前树扫描。
4. 加入正式 `LICENSE`、`NOTICE`、`ASSETS.md`，更新 README 的许可状态。
5. 执行全量测试、真实文件矩阵、浏览器 RBAC、跨 Workspace 隔离与恢复验收。
6. 创建公开仓库或切换可见性，开启安全报告和分支保护，再发布签名镜像。

## 复验命令

```bash
gitleaks git . --redact=100
git archive HEAD | tar -x -C /tmp/unorag-public-tree
gitleaks dir /tmp/unorag-public-tree --redact=100
pnpm licenses list --prod --json
pnpm licenses:check
pnpm audit:prod
git diff --check
```

扫描报告不得提交到仓库，其中可能包含敏感匹配上下文。只提交脱敏后的结论、工具版本和可复现命令。

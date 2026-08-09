# UnoRAG 开源发布准备审计

> 审计日期：2026-08-10
>
> 审计对象：开源候选树，以及候选树之前的 295 个 Git 提交
>
> 当前结论：**源码已采用 Apache-2.0，但尚不可切换为 Public；素材权属、第三方通知、签名和公开历史策略仍是发布阻断项。**

本文件记录公开仓库前的事实与门禁，不代替律师意见。许可授权以仓库根目录 `LICENSE` 为准；
“已开放许可”和“已完成公开发行”是两个不同状态。
产品开源决策见 [ADR-0007](./adr/0007-fully-open-source-product-and-services.md)。

## 已完成

| 检查 | 结果 | 证据 |
|---|---|---|
| 当前跟踪树密钥扫描 | PASS | Gitleaks 8.30.1 扫描 Git archive，0 命中 |
| 完整 Git 历史密钥扫描 | PASS with reviewed exception | Gitleaks 8.30.1 扫描 295 个提交；唯一历史例外是已删除 Python 脱敏测试中的密码 fixture，已按 commit/path/rule/line 精确 allowlist |
| 当前树内部环境检索 | PASS | 未发现真实密钥、客户数据、私钥或本机绝对路径；本地和 Compose 示例地址不计入泄漏 |
| 敏感本地产物隔离 | PASS | `.env*`、运行密钥、备份、验收输出、`.next`、`node_modules` 和本地文档存储均被忽略 |
| 自动防回归 | PASS | CI 全历史 Gitleaks；PR 模板要求隐私与来源确认 |
| 依赖许可证清点 | REVIEWED | 生产依赖共 379 个 package entries、14 种许可证表达式；CI 拒绝未经审阅的表达式漂移 |
| 生产依赖漏洞审计 | PASS | 修复传递依赖 nanoid GHSA-2v37-7h3g-55p8 后，`pnpm audit --prod` 为 0 已知漏洞 |
| 主许可证 | PASS | 根目录 `LICENSE`、`NOTICE` 与 `package.json` 统一采用 Apache-2.0 |
| 依赖更新自动化 | PASS | Dependabot 覆盖 npm、GitHub Actions 和 Docker 基础镜像 |
| 镜像 SBOM / provenance | IMPLEMENTED, NOT RELEASE-VERIFIED | 正式 GHCR/可选 ACR 推送启用 BuildKit attestations；仍须在首个公开 tag 上核验 |
| 四镜像构建 | PASS | web、worker、ops、migrator 均按 `linux/amd64` 构建；运行层以 UID 10001 启动并可读取 `LICENSE`/`NOTICE` |

历史扫描例外只覆盖以下指纹：

```text
46eb2f489df81f41fa825358f10f187d5592e37b:apps/api/tests/test_internal_context.py:generic-api-key:355
```

扩大文件、规则或 commit 范围的豁免不应合并。若扫描出现新命中，应先确认并轮换真实凭据，不得用
allowlist 让 CI 变绿。

## 发布阻断项

### 1. 第三方通知与镜像内容

生产依赖清点包含 MIT、Apache-2.0、BSD、ISC、OFL-1.1、CC-BY-4.0，以及需要单独审阅的
`LGPL-3.0-or-later` libvips 二进制。该二进制由 Next.js 的 Sharp 依赖引入。公开发布镜像前必须：

1. 在首个 tag 上验证每个镜像的 BuildKit SBOM 和 provenance 可按 digest 获取；
2. 生成并随源码和镜像分发完整第三方许可证/NOTICE；
3. 核对 Sharp/libvips 的动态链接、修改、源码获取与通知义务；
4. 确保字体包的 OFL 文本和 caniuse-lite 的 CC-BY-4.0 归属进入分发材料。

不能仅凭 `pnpm licenses list` 的名称判断已经履行再分发义务。

### 2. 素材与测试 fixture 来源确认

下列内容未发现嵌入作者、组织或下载来源元数据，仓库历史显示它们由本项目加入，但仍需要项目所有者
书面确认“自行创作、生成或有权再许可”：

- `public/landing-evidence-desk.png`；
- `public/product-library-workbench.png`；
- `testdata/` 下 PDF、DOCX、图片化扫描件、文本和黄金集。

`ASSETS.md` 已记录新 Uno 品牌矢量及其派生图片的项目内创作来源；其余素材确认后应继续逐组补充
来源、作者/生成方式、许可证和是否允许修改。不能确认的素材必须在公开前替换或删除。测试文件为
合成内容也应明确记录，避免未来被误认为客户文档。

### 3. 公开历史策略

现有历史没有扫描到生产密钥，但包含旧品牌、已退役架构、预发布环境名称、个人邮箱和私有交付过程。
推荐为第一次公开发布创建**经审阅的干净初始历史**，保留当前私有仓库作为内部审计档案；不建议直接
改写正在使用的私有 `main`。若选择公开完整历史，项目所有者必须明确接受这些元数据永久公开，并再次
扫描所有 refs、tag 和 release asset。

### 4. GitHub 发布设置

公开前还需完成：

- 启用 GitHub Private Vulnerability Reporting，并验证 `SECURITY.md` 中的入口；
- 配置分支保护和必需 CI；Dependabot 已配置，Actions 最小权限仍须复核；
- 建立维护者与安全响应渠道，替换临时的个人联系路径；
- 确认 GHCR 镜像公开权限、签名和不可变 tag 策略，并复验 SBOM/provenance；
- 决定 ACR 仅作为镜像镜像站，还是从公开文档中移除个人 Registry 证据。

## 建议发布顺序

1. 项目所有者确认截图、fixture 和最终品牌资产的来源与再分发权利。
2. 生成完整第三方通知和许可证包，完成 libvips/字体义务复核。
3. 决定公开历史策略，在候选公开树再次扫描所有 refs、tag 和 release asset。
4. 在精确 RC commit 执行全量测试、真实文件矩阵、浏览器 RBAC、跨 Workspace 隔离与恢复验收。
5. 创建公开仓库或切换可见性，开启安全报告和分支保护。
6. 发布不可变镜像，核验 SBOM/provenance，接入签名后再发布正式 `v0.1.0`。

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

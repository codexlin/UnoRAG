# UnoRAG 开源与稳定版发行审计

> 审计日期：2026-08-23
>
> 审计对象：公开仓库当前树、完整 Git 历史、预发行镜像与 GitHub 安全设置
>
> 当前结论：**仓库已公开并采用 Apache-2.0；素材、许可证、SBOM/provenance、漏洞扫描和镜像签名均已在 RC.18 验证。稳定 `v0.1.0` 只剩最终精确版本的完整复验与发布。**

本文件记录公开仓库和稳定版发行的事实与门禁，不代替律师意见。许可授权以仓库根目录 `LICENSE` 为准；
“仓库公开可见”和“稳定发行材料已完整验证”是两个不同状态。
产品开源决策见 [ADR-0007](./adr/0007-fully-open-source-product-and-services.md)。

## 已完成

| 检查 | 结果 | 证据 |
|---|---|---|
| 当前跟踪树密钥扫描 | PASS | Gitleaks 8.30.1 扫描 Git archive，0 命中 |
| 完整 Git 历史密钥扫描 | PASS with reviewed exception | Gitleaks 8.30.1 扫描 357 个可达提交；唯一历史例外是已删除 Python 脱敏测试中的密码 fixture，已按 commit/path/rule/line 精确 allowlist |
| 当前树内部环境检索 | PASS | 未发现真实密钥、客户数据、私钥或本机绝对路径；本地和 Compose 示例地址不计入泄漏 |
| 敏感本地产物隔离 | PASS | `.env*`、运行密钥、备份、验收输出、`.next`、`node_modules` 和本地文档存储均被忽略 |
| 自动防回归 | PASS | CI 全历史 Gitleaks；PR 模板要求隐私与来源确认 |
| 依赖许可证清点 | REVIEWED | 生产依赖（含可选 COS provider）共 440 个 package entries、15 种许可证表达式；CI 拒绝未经审阅的表达式漂移 |
| 素材与 fixture 溯源 | PASS | `assets/provenance.json` 对公开视觉资产与合成测试资料逐文件绑定 SHA-256；CI 拒绝遗漏和未登记修改 |
| 第三方许可证分发 | PASS | 构建时从生产依赖树生成完整 `THIRD_PARTY_NOTICES.txt`，四类发行镜像均携带该文件；缺失许可证文本时构建失败 |
| 生产依赖漏洞审计 | PASS | 修复传递依赖 nanoid GHSA-2v37-7h3g-55p8 后，`pnpm audit --prod` 为 0 已知漏洞 |
| 主许可证 | PASS | 根目录 `LICENSE`、`NOTICE` 与 `package.json` 统一采用 Apache-2.0 |
| 依赖更新自动化 | PASS | Dependabot 覆盖 npm、GitHub Actions 和 Docker 基础镜像 |
| GitHub 安全设置 | PASS | 主干强制 PR 与五项 CI；Private Vulnerability Reporting、Dependabot Security Updates、Secret Scanning 与 Push Protection 已启用 |
| 公开历史策略 | COMPLETE | 当前公开仓库保留完整历史；公开前完整历史扫描通过，后续发布继续扫描所有 refs、tag 与 release assets |
| 镜像 SBOM / provenance | PASS | RC.18 四个 GHCR digest 均可匿名读取 OCI attestation manifest，同时包含 SPDX Document 与 SLSA provenance v1 |
| 四镜像构建 | PASS | web、worker、ops、migrator 均按 `linux/amd64` 构建；运行层以 UID 10001 启动并可读取 `LICENSE`/`NOTICE` |
| 镜像签名 | PASS | RC.18 四个 GHCR 与 ACR digest 均由 release workflow 使用 GitHub OIDC keyless Cosign 签名并在发布流水线和 HK 升级前 fail-closed 自验 |
| COS 真实链路 | PASS | RC.14 在空环境使用真实 CAM/COS 完成上传、读取、替换、删除和完整产品生命周期；RC.18 延续同一存储边界 |

本轮素材与许可证工程审阅由 UnoRAG maintainers 于 2026-08-14 完成。证据包括 Git 历史、素材哈希、
文件元数据、fixture 生成器、`pnpm licenses list --prod --json`、四类本地 Linux 镜像内容检查，以及下方复验命令。

历史扫描例外只覆盖以下指纹：

```text
46eb2f489df81f41fa825358f10f187d5592e37b:apps/api/tests/test_internal_context.py:generic-api-key:355
```

扩大文件、规则或 commit 范围的豁免不应合并。若扫描出现新命中，应先确认并轮换真实凭据，不得用
allowlist 让 CI 变绿。

## 已完成的稳定版前置

### 1. 第三方通知与镜像内容（已工程化）

生产依赖清点包含 MIT、Apache-2.0、BSD、ISC、Unlicense、OFL-1.1、CC-BY-4.0，以及
`LGPL-3.0-or-later` libvips 二进制。构建会从实际 Linux 生产依赖树收集许可证原文，按内容去重生成
`THIRD_PARTY_NOTICES.txt` 并放入 web、worker、ops 和 migrator 镜像。CI 同时保留许可证表达式白名单门禁。

RC.18 已完成：

1. 每个 GHCR digest 的 OCI attestation 都包含 SPDX SBOM 和 SLSA provenance；
2. 四个 Linux 镜像中的 `THIRD_PARTY_NOTICES.txt` 均包含 libvips、Fontsource 字体和 caniuse-lite；
3. web、migrator、ops 和 worker 均以 UID 10001 运行，并携带 `LICENSE`、`NOTICE` 和非空第三方通知；
4. Trivy 对四镜像执行 HIGH/CRITICAL 门禁，Cosign 对 GHCR/ACR digest 完成签名和身份自验。

后续仍须保持：

1. 每个正式标签重新验证 attestation、许可证包和签名，不能把 RC.18 的结果自动继承给新 digest；
2. 若修改 libvips 或其链接方式，重新核对 LGPL 源码提供义务。

不能仅凭 `pnpm licenses list` 的名称判断已经履行再分发义务。

### 2. 素材与测试 fixture 来源确认（已完成）

公开视觉内容和 `testdata/` 已逐项核验为项目创建的品牌资产、产品截图或合成测试资料，不包含客户
文档和个人信息。`ASSETS.md` 解释来源，`assets/provenance.json` 绑定逐文件哈希；新增或修改素材必须
同步更新清单，否则 CI 失败。无法证明再分发权的素材不得通过更新哈希绕过来源审查。

### 3. 公开历史持续审计

当前公开仓库已经保留完整历史。公开前扫描未发现生产密钥，已知的单个历史测试 fixture 使用精确
allowlist；旧品牌、已退役架构、预发布环境名称和提交者元数据已经成为公开历史的一部分，不再把“重建
干净历史”列为可执行发布路径。每次稳定发布仍须扫描所有 refs、tag 和 release assets，并保持豁免范围
不扩大。

### 4. GitHub 发布设置

已完成：

- GitHub Private Vulnerability Reporting 与 `SECURITY.md` 已可访问；
- 主干强制 PR 和五项必需 CI，Dependabot、Secret Scanning 与 Push Protection 已启用。

稳定发布还需在最终标签确认：

- GitHub Issues、Discussions 和 Private Vulnerability Reporting 仍可用，并在 release notes 中明确社区支持不承诺 SLA；
- GHCR 公开拉取、签名和不可变 tag 策略仍有效，并按稳定 digest 复验 SBOM/provenance；
- 明确 ACR 仅作为可选镜像站，不让个人 Registry 凭据或环境证据进入发行材料。

## 稳定版剩余门禁

1. 从最终 `main` 提交创建 `v0.1.0`，再次扫描所有 refs、tag 和 release assets；
2. 对稳定四镜像执行漏洞、匿名拉取、许可证包、SBOM/provenance 和 Cosign 身份复验；
3. 在精确稳定 digest 上执行全量测试、真实文件、浏览器 RBAC/ACL、COS 生命周期、故障与备份恢复、
   应用回滚再前滚和容量验收；
4. 发布 digest manifest、release notes、已知限制、升级路径和版本绑定证据，并确认线上健康端点与 manifest 一致。

工程审计不代替商标法律意见。当前 UnoRAG 标识为项目原创且有来源和使用政策，但仓库不宣称名称或图形
已在任一地区注册；正式检索和注册由维护者根据目标市场另行决定，不作为代码供应链门禁伪装成自动 PASS。

## 复验命令

```bash
gitleaks git . --redact=100
git archive HEAD | tar -x -C /tmp/unorag-public-tree
gitleaks dir /tmp/unorag-public-tree --redact=100
pnpm licenses list --prod --json
pnpm licenses:check
pnpm notices:check
pnpm assets:check
pnpm audit:prod
git diff --check
```

扫描报告不得提交到仓库，其中可能包含敏感匹配上下文。只提交脱敏后的结论、工具版本和可复现命令。

# c066377 解析修复与上传复验

> 日期：2026-11-05。结论：**解析、上传与功能质量通过；稳定性总门禁 FAIL，暂不提升为新稳定版**。
> 本轮升级的是不可变候选，不是新稳定版；历史 RC 的通过项不自动继承到本提交。

## 版本与环境

- 运行提交：`c0663777d8195e5aa3d8fee3bfc37e83c31e057c`，版本 `0.2.3-dev+c0663777d819`。
- DBOS application version：`unorag-c0663777d8195e5a`；四镜像均为原生 `linux/amd64`。
- 香港参考实例：2 vCPU / 4 GB，Compose、COS、DashScope `qwen-plus` / `text-embedding-v3`，
  外部 PDF Provider 为 302.AI MinerU；rerank 未启用，不能以本轮证明 rerank 质量。
- [修复 PR #183](https://github.com/codexlin/UnoRAG/pull/183)、
  [精确主干 CI](https://github.com/codexlin/UnoRAG/actions/runs/41882234515)、
  [四镜像构建、扫描与签名](https://github.com/codexlin/UnoRAG/actions/runs/41881942243) 均通过。

| 镜像 | GHCR index digest |
|---|---|
| Web | `sha256:879fbc35118a01b905421b3f23eeb0ae476495475d70b3aa0cb9ea21561490b9` |
| Migrator | `sha256:76160729215b732dfd2f5ddb31f5b0028c592a14e414d0ce882bbdd557bc353f` |
| Ops | `sha256:0dd7ad043c8c0fd59c4f1ac9acd88627e43fc7efa3391f18e363c8424065d4dd` |
| Worker | `sha256:f0b55fc7be712a81b79cbba449cfa43bf57e951d16c4eec0f2e35f056b7a5d9f` |

Manifest SHA-256：`2602fa009f86448d6fcce32fcb4abc734f58a63addbcafb1a98f4da0256f508a`。
镜像使用既有 Trivy HIGH/CRITICAL、`ignore-unfixed` 策略，未增加豁免；目标服务器验签后再升级。

## 问题归因

原候选 `ca8aef0` 的真实 302.AI MinerU 上传已成功，不能把下面的内部问题归为外部服务故障：

1. 解析状态展示只读取旧 provenance 字段，误将云解析显示为自建、未出域。
2. Compose / Helm 控制进程漏传 `MINERU_PROVIDER`，运行中心误报 MinerU 禁用。
3. 单独补测的本地 LiteParse OCR 使用旧 `ch` 语言码，Tesseract 尝试下载不存在的语言数据；
   Worker 镜像也未预装 OCR 模型。该 404 不是 MinerU API 返回的错误。

修复只规范语言码、预装中文/英文数据、缺依赖时明确失败、使用实际安装的 LiteParse 版本，
并纠正来源展示及控制配置；没有更换 Provider、调整解析路由、切分、检索或降低 OCR 置信度阈值。

## 已完成复验

| 项目 | 结果 | 证据范围 |
|---|---|---|
| 确定性与集成检查 | PASS | Fast 691/691；真实 PG/Qdrant/Redis Integration 79/79，均无跳过；verify、依赖审计和生产构建通过 |
| 断网 OCR 镜像冒烟 | PASS | 本机 ARM64 及 CI AMD64；真实文字 PDF、扫描 PDF，`--network none`、只读镜像和临时目录；扫描件保留 partial 警告 |
| 原本失败的本地 PDF | PASS | 浏览器触发重索引，LiteParse 2.14.7 完成；v2 active、v1 失败历史保留，实际解析未出域 |
| 本地扫描 PDF | PASS，质量有警告 | 严格本地解析完成入库；一条低置信度警告、partial 与失败页提示仍可见，不冒充无损识别 |
| 浏览器多格式上传 | 8/8 completed | MD、TXT、两份 DOCX、四份 PDF；UI 8 份就绪；全部有八阶段起止和耗时，无页面脚本错误 |
| 外部 MinerU | 4/4 completed | 文字、扫描、图文与页眉页脚 PDF 均经真实 302.AI，失败页为空；UI 正确显示云解析和已出域 |
| 生命周期 | 12/12 PASS | 格式拒绝、COS 原文哈希、重索引/替换、失败保留旧版、单文件替换、失败诊断、重试/取消、匿名拒绝与产品删除 |
| 浏览器自动化 | 22/22 PASS | 桌面与移动 Chromium，真实登录、页面与水合；高频 SSE、竞态及部分诊断使用受控响应，不冒充真实模型质量 |
| MinerU 健康展示 | PASS | 控制进程正确读取 302.AI 配置，configuration 模式显示 healthy；不是实时探测外部服务，真实可用性另由上述上传证明 |

## 黄金集

首次完整运行 `ab-stability-20261104T182935Z` 的三轮问答均为 36/36 正例、5/5 拒答，
共 123/123，P95 分别为 13.17 / 13.13 / 12.84 秒，model_error 为 0；但**总门禁 FAIL**。
三轮镜像、模型和 Prompt 指纹相同，失败原因是评测期间整理文档，导致 runner 在每轮结束时记录
`git_dirty=true`。门禁要求干净工作区，不能把这次失败改写为通过，也不能归咎于外部 MinerU。

随后从精确 `c066377` 的独立干净检出重新执行，新运行 `ab-stability-20261104T184728Z`：
7 份新鲜真实文件全部完成入库；三轮 `git_dirty=false`、镜像/模型/Prompt 指纹一致，model_error 为 0。
每轮正例 36/36、拒答 5/5，共 123/123，按版本化黄金集评分的事实覆盖、召回与 citation precision 均为 100%。

| 干净检出轮次 | 正例 | 拒答 | P50 | P95 | 最大耗时 |
|---|---:|---:|---:|---:|---:|
| 1 | 36/36 | 5/5 | 7.89 s | 12.19 s | 14.34 s |
| 2 | 36/36 | 5/5 | 7.57 s | 13.42 s | 25.90 s |
| 3 | 36/36 | 5/5 | 7.55 s | **16.11 s** | 29.03 s |

第三轮 P95 为 16,109.9 ms，超过原有 15,000 ms 门槛，因此 **Ask stability gate / release gate FAIL**，
不能只凭 123/123 宣称稳定性通过。没有调高阈值、关闭 Judge、重评分或继续重跑挑选通过结果。

只读排查显示，第三轮两个最长请求分别耗在生成阶段 22.18 秒、Judge 阶段 25.95 秒；后者有两次
应用层 Judge 尝试。两者检索分别约 0.74 / 0.57 秒。这将长尾定位到模型调用阶段，不是 MinerU/OCR；
尚不能区分上游推理/排队、网络与 SDK 内部重试，后续跟踪
[#185 Ask P95 长尾](https://github.com/codexlin/UnoRAG/issues/185)，不在本次解析修复中擅自改模型策略。

干净检出总报告 SHA-256：`4b59755ce82ba9dd94a1e08fc08bbda6ef8674e799975222c10d9f60e0aa7333`。
三轮原始报告为 `ab_live_20261104T183054Z-d39e9974`、`ab_live_20261104T183658Z-f950e778`、
`ab_live_20261104T184155Z-f1aabfa3`；首次 dirty 运行及其 FAIL 原样保留。

## 升级与边界

升级前维护窗口备份 PostgreSQL、DBOS 与 Qdrant，五项校验和通过；COS 对象保留在原桶中，
该备份不是桶级恢复证明。任务排空、迁移检查、四镜像切换和产品 smoke 均通过；未在正式实例做破坏性 restore。
两次黄金集临时库均由产品 API 删除并等待完成；最终巡检 dead / stuck / deleting / cleanup errors /
pending ACL 均为 0。专用浏览器验收知识库保留供人工查看，没有清除失败历史来美化结果。

本地首次并行检查触发过未改动清理测试的 100ms 超时；独立重跑与 PR/main CI 均通过，未修改该测试。
浏览器测试中通知悬停遮挡刷新按钮，另一次后续操作因没有打开详情而超时；移开指针、重新核对页面状态后
复验成功，没有强制点击、修改 UI 或把测试编排错误归咎于解析服务。

本轮没有启用完整 Ops Stack / Langfuse、自建 MinerU，也没有重做空安装、容量、故障注入与灾难恢复门禁。
复杂图表数值理解、任意扫描件质量和客户环境 SLA 不在本轮承诺范围。

公开仓库只保存汇总；原始 jobs、阶段账本、浏览器截图、生命周期与质量报告保存在受控验收目录，
不提交凭据、环境文件、完整问答或引用正文。浏览器验收知识库保留供人工查看；黄金集临时库由 runner 通过产品删除。

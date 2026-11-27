# UnoRAG 产品设计规范

> 更新日期：2026-11-23。本文是产品界面、交互、动效及 UI 选型的唯一规范入口。
> 当前能力与发布限制见 [STATUS](./STATUS.md)，品牌图形资产见 [Uno 品牌系统](./brand/uno-brand-system.md)。

样式调整必须以完整功能为基线，不得因“更简洁”而删除已有权限、版本、任务、诊断或设置入口；简化演示稿不构成 API 或功能契约。

| 主题 | 跳转到 |
|---|---|
| 风格、双密度与证据链 | [产品风格与密度](#产品风格与密度) · [能力与页面对应](#能力与页面对应) |
| 核心业务页面边界 | [核心页面规则](#核心页面规则) |
| 主题、配色、字体与状态 | [视觉系统](#视觉系统) · [数据与状态表达](#数据与状态表达) · [反馈与动效](#反馈与动效) |
| 组件选型与验收底线 | [组件与动画选型](#组件与动画选型) · [验收底线](#验收底线) |

---

## 产品风格与密度

设计方向为**证据驱动的专业工作台**：瑞士式排版、扁平层级、中性材质；以**清楚、可信、可控、一致**为判断标准，不靠装饰特效撑场。

| 页面 | 首要任务 | 密度与布局 |
|---|---|---|
| 智能问答 | 阅读答案、核对依据 | 舒适阅读列（~768px，16px / 1.85 行高），无框回答正文；引用与链路按需展开，不常驻固定宽证据栏 |
| 知识库 | 查找文档、判断可用性、执行治理 | 独立可折叠库侧栏 + 文档台账主体；可用性与最近任务分列呈现 |
| 文档详情 | 核对版本、原文件与解析结果 | 抽屉按「概览 / 版本 / 处理记录」分区，长解析报告默认折叠 |
| 运行中心 | 发现异常、下钻排查 | 紧凑指标 + 阶段瀑布 + 请求筛选列表；严格 `metadata-only` |
| 设置与账号 | 明确配置与安全登录 | 分组表单 + 字段校验 + 权限提示；不采用监控台高密度 |

### 证据关联主链路

核心闭环：**答案 → 引用 → 原文片段 → 生效版本 → 本次执行链路**。

1. 引用编号在单轮回答内稳定，指向实际授权来源，不因排序重编号。
2. 点击/悬停引用展示文档、页码/行组/章节和快照 `document_version_id`；历史回答必须核对**当次所用版本**，绝不静默替换成当前 active 版本。
3. 链路入口绑定真实 `request_id` / `job_id`；缺失时明确显示未记录，不伪造示例数据。
4. 切库/切工作区立即隔离客户端缓存与流式回调，绝不跨区残留证据。

---

## 能力与页面对应

任何页面改动不得遗漏下表能力；纯呈现、局部交互优化与新增数据契约须分开审查：

| 领域 | 必须保留的能力 | 当前源码入口 |
|---|---|---|
| 全局与工作区 | 导航、工作区创建/切换、角色可见性、主题/圆角、语言切换、退出 | [nav-items.ts](../src/components/app/nav-items.ts)、[workspace-switcher.tsx](../src/components/app/workspace-switcher.tsx) |
| 问答 | 多库选择、就绪提示、流式生成/停止、引用预览与面板、拒答原因、归档、续聊、链路与用量抽屉 | [ask-workspace.tsx](../src/components/app/ask/ask-workspace.tsx)、[ask-trace-drawer.tsx](../src/components/app/ask/ask-trace-drawer.tsx) |
| 知识库 | 建库、编辑/删除、解析/切分偏好、重索引提示、搜索、多文件上传与逐项结果 | [libraries-panel.tsx](../src/components/app/libraries-panel.tsx)、[library-dialogs.tsx](../src/components/app/libraries/library-dialogs.tsx) |
| 文档治理与诊断 | 查看、ACL、替换、重索引、取消/重试、下载、删除、版本历史、入库瀑布、按需解析报告 | [library-doc-actions.tsx](../src/components/app/library-doc-actions.tsx)、[document-detail-sheet.tsx](../src/components/app/document-detail-sheet.tsx) |
| 会话历史 | 按日期分组列表、服务端搜索/筛库、加载更早会话、逐轮回放、继续原 thread | [archive-panel.tsx](../src/components/app/archive-panel.tsx) |
| 运行中心与审计 | Ask/队列统计、健康状态、告警及投递、请求筛选/翻页、错误抽屉、独立审计页与 CSV 导出 | [operations-dashboard.tsx](../src/components/app/operations-dashboard.tsx)、[operations-requests-panel.tsx](../src/components/app/operations-requests-panel.tsx)、[workspace-audit-panel.tsx](../src/components/app/workspace-audit-panel.tsx) |
| 设置与账号 | 问答策略（回答模式 / 检索精排 Auto·开·关 / 对话记忆）、Owner 级模型与供应商配置（含连通性探测与部署锁定态）、成员/邀请、Service Key、告警阈值、邮件通知策略/测试、服务信息；登录/改密/邀请/邮箱访问 | [settings/page.tsx](../src/app/app/settings/page.tsx)、[login/page.tsx](../src/app/login/page.tsx) |

---

## 核心页面规则

### 知识库与文档治理
- **双状态分离**：“现在能否用于问答（可用性）”与“最近一次处理任务”必须分开表达（例如“旧版仍可用”同时显示“新版更新失败”），不能混成一个状态徽标。
- **数据边界**：不把 UUID 截断当 `v3`，不逐行发起 N+1 版本历史请求；文档台账按服务端分页、搜索与任务筛选加载轻量列表，打开文档详情时按需读取解析报告；页数、上传字节进度仅在接口真实返回时显示；名称搜索按显示名和原文件名过滤，不标成“全库全文搜索”。
- **多文件上传结果**：逐文件区分“提交中 / 已接受 / 提交失败”；已接受不等于索引完成，关闭结果区不取消后台任务。

### 问答、输入区与会话历史
- **流式稳定性**：同一轮本地 UI ID 与 Markdown renderer 在流完成前后保持稳定，不重新挂载或丢失选区；用户选中来源按 `turnId + sourceId` 双键定位。
- **来源诚实**：来源详情标为“来源片段”而非“完整原文”；表格行号界面按 1 起算、快照保留 0 起算；检索分数按实返回，不把 BM25/RRF 伪装成概率条。
- **消息操作栏**：使用 `MessageFooter` + shadcn ghost 图标按钮（16px 图标、44px 点击区）；生成中不提供整段复制；拒答保留实际原因，不叠泛化重复句。
- **输入区**：采用 `InputGroup`（`inline-end`），常态 64–80px、多行上限 200px，不预留未实现的附件或模型切换行。

### 运行中心与设置
- 概览状态综合服务端 `overall`、快照新鲜度与活动告警；未知统计保留未知，不填零；Provider 配置就绪不等于调用成功。
- 阶段瀑布仅在有可信起止时间时称时间轴；仅有 `duration_ms` 时按顺序展示耗时，不猜并行区间。
- 设置页使用桌面次级导航 + 手机顶部选择器，保留 `#ask-settings` / `#models`（仅组织 Owner）/ `#members` / `#integrations` / `#notifications` / `#service` 深链接；一次性 Service Key 与邀请明文关闭前提醒确认并从内存清理，连同模型 API Key 均不回显、不进入 URL/Toast/日志。
- 双语支持 `简体中文` / `English`（由浏览器 Cookie → `Accept-Language` → English 服务端首屏解析），不加 URL 语言前缀，不改写用户内容与 API 状态值。

### 对外首页与登录外壳
- 首页共用主题、字体与基础控件；产品动效视频与静态 Poster 由离线 `tools/landing-video/`（Remotion，不进生产镜像与运行时依赖）生成至 `public/landing-media/`，`prefers-reduced-motion` 下停用自动播放直接显示 Poster；`EvidenceExplorer` 保持纯只读示例。
- 登录/邀请/邮箱访问/首次改密使用统一轻量外壳；输入 16px / 44px 高度，保留 SSR 外壳与水合后凭据挂载以兼容密码管理器。

---

## 视觉系统

### 主题、配色与圆角
- 内置 4 套 tweakcn 主题：**Vercel（默认深色）**、**Modern Minimal**、**Claude**、**Violet Bloom**，与明暗（`next-themes` / `unorag-theme`）及圆角（`unorag-appearance-v1`，跟随预设或 0–12px 0.5px 步进自定义）正交组合。
- 主题快照存于 `src/styles/themes/`，由 `pnpm themes:generate` 生成 `src/styles/themes.css` 并由 `pnpm themes:check` 防漂移；禁止运行时远程加载主题或任意 CSS 注入。

| 产品语义 | 浅色参考 | 深色参考 | 规则 |
|---|---|---|---|
| 有效引用 / 交互强调 | 主题强调色阶 (`evidence`) | 主题强调色阶 (`evidence`) | 与成功绿严格分离 |
| 成功 | `#28734C` (`cite`) | `#8DCDAB` (`cite`) | 不随主题主色改变 |
| 等待 / 降级 / 告警 | `#795014` / `#FCF3DF` | `#EDCB91` / `#352B1C` | 必须同时配文字或图标 |
| 失败 / 危险操作 | `#B42318` | `#F1A2A2` | 不使用预设可能为黑色的 destructive |

- **层次与克制**：通过中性背景、4px 间距与细分隔线建立层次，不套娃卡片；不使用常驻模糊光晕、粒子背景、外发光或大面积玻璃态。正文对比度 ≥ 4.5:1，大字与非文字控件 ≥ 3:1。
- **主操作唯一性**：每个明确任务区仅一个默认 `Button`（primary），次级动作使用 outline/ghost，危险操作使用 destructive。

### 字体与排版
- 字体全自托管或系统回退（Vercel: Geist / Geist Mono；Claude: 系统无衬线/等宽；Violet Bloom: Plus Jakarta Sans / IBM Plex Mono；中文系统回退），**零运行时 Google Fonts / CDN 请求**。
- 问答与原文 16px（行高 1.7–1.9），常规界面 14px，次级元信息 ≥ 12px，手机表单输入 ≥ 16px / 44px 高度；等宽字体仅用于 ID、代码和对齐数值。

---

## 数据与状态表达

| 场景 | 必须表达 | 禁止表达 |
|---|---|---|
| 文档替换失败 | 新版任务失败 + 旧版仍可检索 | 整份文档直接标“不可用” |
| 上传与入库 | 传输、排队、解析、切分、向量化、激活分步表达 | 上传 100% 就称“已索引” |
| 未知进度 / 耗时 | 已确认阶段与已等待时间；不强行求和并行/重试耗时 | 模拟进度条或把子耗时相加冒充总耗时 |
| Token / 成本 | 实报用量、部分已知、未知、未调用 LLM 严格区分 | 缺失填 0 或无依据估算金额 |
| Rerank / 错误 | 配置就绪 vs 实际执行/降级分开；错误含阶段、分类、关联 ID | 未经证据把超时归因到网络或用户 |
| 诊断隐私 | 默认 `metadata-only`；任何原文透视仅限本人授权内存态 | 为“完整链路”把正文写入持久化运维日志 |

---

## 反馈与动效

- **统一节奏**：Hover/按下 `120–160ms`；局部展开 `160–200ms`；抽屉/弹窗 `180–240ms`；复杂切换 ≤ `280ms`。统一 ease-out，优先 `transform` / `opacity` / 颜色过渡，禁止 `transition: all`、回弹晃动及对长列表逐行做 layout 动画。
- **流式与轮询**：不对单个 Token 加动画；后台轮询只更新变化项，不闪屏、不重放入场动画、不抢走焦点或滚动位置。
- **Reduced Motion 与无障碍**：CSS 尊重 `prefers-reduced-motion`，Motion 使用 `MotionConfig reducedMotion="user"`；减少动态效果时关闭位移、自动滚动和循环装饰；核心路径全键盘可达，触屏目标 ≥ 44×44px，屏幕阅读器不逐 Token 播报。

---

## 组件与动画选型

不引入并行组件库（如 Radix）或第二套动画引擎（如 GSAP / Three.js / `framer-motion`）：

| 能力 | 选型与边界 |
|---|---|
| 基础原语 | Base UI + shadcn/ui `base-nova` 本地源码（`src/components/ui/`），保留键盘与焦点语义 |
| 常规控件 | Slider / RadioGroup / Checkbox / Switch / Dialog / Tabs / 标准 Base UI `Select`（禁止 `NativeSelect` 或原生事件包装层） |
| 问答界面 | shadcn Base UI AI Elements（`Message` / `MessageFooter` / `MessageScroller` / `InputGroup` / `Sources` / `Inline Citation` / `Trace`），不替换既有 SSE 状态机与授权契约；未提供接口能力的 `Reasoning` / `Tool` / `Attachments` 不启用 |
| 动效与提示 | Tailwind CSS + CSS transition 优先；状态协调按需用 `motion/react`；短暂确认用 Sonner；图标统一 Lucide |
| 允许原生例外 | 原生文件输入、全局灾难错误页最小恢复按钮、具有独立排版/焦点契约的行内引用（新增例外须在此登记） |
| 装饰组件参考 | Magic UI / Aceternity UI / React Bits 仅可按需审慎借鉴局部源码，必须核查许可/SSR/reduced-motion 并统一到本产品 Token |

---

## 验收底线

任何 UI 改动合并前确认：

- [ ] 浅色/深色 × 320 / 390 / 768 / 1024 / 1440px 无横向溢出、裁切或焦点丢失；
- [ ] 全键盘操作与 44px 触屏热区可用，不依赖桌面 Hover 才暴露核心动作；
- [ ] 空态、加载、取消、失败、拒答、旧版可用+新版失败、未知用量均忠实展示；
- [ ] `prefers-reduced-motion` 下无自动播放/位移/循环装饰，轮询与切库不污染当前状态；
- [ ] `pnpm verify`、`pnpm test:fast` 及相关 E2E 旅程通过。

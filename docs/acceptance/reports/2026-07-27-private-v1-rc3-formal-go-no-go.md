# Private Deployment v1.0 RC3 正式验收 / 签字结论稿

> **状态：待审批人签字** — 技术侧建议 **Conditional GO**。  
> 本文提交到仓库不等于完成签字，也不代表通用生产 GA。

## 唯一审批对象

| 字段 | 值 |
|---|---|
| **批准发布候选 SHA** | `a25575288c44e39ff24613b30e59d0ebc56993a7` |
| 产品版本 | Private Deployment v1.0 RC3 |
| 验收记录提交 | `7a2e9df58df97e6c604f5a70f823c316ed51ef7b`（仅新增 RC3 浏览器验收报告） |
| 远端状态 | `origin/main` 已包含上述产品提交与验收记录 |
| 日期 | 2026-07-27 |
| 模板 | [`../pilot-go-no-go-template.md`](../pilot-go-no-go-template.md) |

审批或打 tag 时应以 **`a25575288c44e39ff24613b30e59d0ebc56993a7`**
作为唯一产品发布对象。`7a2e9df` 只记录验收结果，不改变产品代码。

## RC3 直接证据

| 门禁 | 结果 | 说明 |
|---|---|---|
| 完整私有化栈真实浏览器主路径 | **PASS** | 登录、建库、上传、索引、Ask、引用、Trace、归档、Service Key |
| 移动端关键页面 | **PASS** | Ask、知识库、设置；390px 页面无整体横向溢出 |
| API pytest | **PASS** | `307 passed / 8 skipped` |
| Web tests | **PASS** | `105 passed / 3 skipped` |
| Web lint | **PASS** | 仅 Biome 配置弃用提示 |
| Next production build | **PASS** | production build |
| 数据迁移真实执行 | **PASS** | `0010_reconcile_library_counts.sql` |
| RC3 推送后 preflight | **PASS** | isolation `2/2`；CI release gate `36/36` |
| 浏览器 console | **PASS** | 最终轮 `error=0`、`warn=0` |

直接证据见
[`2026-07-27-private-v1-rc3-browser.md`](./2026-07-27-private-v1-rc3-browser.md)。
推送后 preflight 在干净 `7a2e9df` 上复跑；该提交相对产品候选
`a255752` 的唯一差异是新增上述 Markdown 验收报告。

## 继承的生产试点证据

RC3 沿用 RC2-X 已完成的生产试点证据。以下项目本轮未伪装成
“绑定 RC3 的重新演练”，原始运行时 SHA、哈希与限制以附件为准。

| 项目 | 结果 | RC3 使用方式 |
|---|---|---|
| S1 / S2 跨组织、跨工作区隔离 | **PASS** | 历史实测 + RC3 preflight 隔离回归 |
| B2 独立备份恢复 | **PASS** | 继承历史故障演练证据 |
| R1–R4 故障注入 | **PASS** | 继承历史故障演练证据 |
| B3 升级演练 | **PASS** | 继承历史升级证据 |
| B4 应用回滚 / 备份恢复 | **PASS** | 继承历史回滚证据 |
| B5 五项最低告警链路 | **PASS（有限制）** | 继承历史 firing → webhook → resolved 证据 |

RC3 变更集中在浏览器工作流、知识库计数修复、迁移、响应式布局、
Service Key 明文清理与构建上下文，不修改 B2、R1–R4、B3/B4、B5
验收脚本的核心语义。审批人若要求“所有故障演练必须绑定同一 SHA”，
应在签字前对 RC3 另开窗口重跑，不得用历史 PASS 替代。

## 已知限制与发布条件

| # | 限制 | 发布前处理 |
|---|---|---|
| 1 | B5 webhook 尚未绑定真实生产接收通道，也没有确定常驻运行方式 | 配置接收端、值班人和 `watch` / cron / systemd 之一，或由审批人书面接受 |
| 2 | S5 为真实 `df` 测量 + force 注入，并非真实灌盘 | 审批人书面接受，或安排隔离环境真实阈值演练 |
| 3 | 本地 `pilot-smoke` 的 admin 密码仍是 placeholder | 目标部署换真实密钥后重跑 |
| 4 | RC3 未重跑全部破坏性故障、升级和恢复演练 | 若审批策略要求同 SHA 全量绑定，则签字前重跑 |
| 5 | 实测 Ask 有两条低相关引用被展示 | 不影响正确答案；进入检索质量阶段建立评测集并收紧引用展示策略 |
| 6 | 当前是单节点 Compose 拓扑 | 仅面向边界明确的受控私有化部署，不承诺 HA / 自动扩缩容 |

## 技术结论

- [x] **Conditional GO（技术侧建议）** — 可进入边界明确、有人值守的私有化试点。
- [ ] **GO** — 仅由审批人在接受或关闭上述限制后勾选。
- [ ] **NO-GO**

本结论表示 RC3 已具备可演示、可部署、可试点的产品主路径；它不表示已经
完成通用生产 GA、企业采购合规、HA 或标准化可观测平台。

## 审批人签字栏

| 字段 | 填写 |
|---|---|
| **批准发布 SHA** | `a25575288c44e39ff24613b30e59d0ebc56993a7`（或等价 tag：________） |
| 结论（勾选恰好一项） | [ ] GO [ ] Conditional GO [ ] NO-GO |
| 部署边界 / 客户环境 | ________________ |
| B5 接收端与常驻方式 | ________________ |
| 值班负责人 | ________________ |
| 审批人姓名 | ________________ |
| 日期 | ________________ |
| 一句话理由 | ________________ |
| 签字确认 | ________________ |

## 附件

| 附件 | 路径 |
|---|---|
| RC3 真实浏览器与质量门禁 | [`2026-07-27-private-v1-rc3-browser.md`](./2026-07-27-private-v1-rc3-browser.md) |
| RC2-X 正式签字稿（历史基线） | [`2026-07-27-pilot-formal-go-no-go.md`](./2026-07-27-pilot-formal-go-no-go.md) |
| S1 / S2 | [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md) |
| B2 + R1–R4 | [`2026-07-26-pilot-rc-b2-r-fault.md`](./2026-07-26-pilot-rc-b2-r-fault.md) |
| B3 / B4 | [`2026-07-27-pilot-rc-b3-b4.md`](./2026-07-27-pilot-rc-b3-b4.md) |
| B5 | [`2026-07-27-pilot-rc-b5-min-alerts.md`](./2026-07-27-pilot-rc-b5-min-alerts.md) |


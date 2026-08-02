# Production-ready 定义清单

仅当 A–E 必选项均为 **是**、F 类非阻断项已写入已知限制，才可针对经过验收的
UnoRAG 版本与部署环境宣称 **production-ready**（私有化企业知识服务）。

本清单对齐 [`PRODUCT.md`](../PRODUCT.md) 的发布口径与 [`ROADMAP.md`](../ROADMAP.md) P0。勾选前须有证据
（报告、gate JSON、演练记录），而不是「代码看起来齐了」。

## A. 正确性

- [ ] 上传均产生真实 `document_version` + `generation` + `job`
- [ ] 未激活 generation 零召回（门禁 / 试点验证）
- [ ] 新版本失败时旧 active 继续服务
- [ ] 激活后单次查询不混合新旧 chunk
- [ ] citation 可定位真实 `document_version_id`
- [ ] retry / cancel / delete 幂等（至少演练一轮）

## B. 安全

- [ ] 跨 organization / workspace / group 零泄漏（硬熔断 0）
- [ ] viewer 不能上传、retry、cancel、删除
- [ ] worker / runtime DB 角色最小化（非 migrator 跑业务）
- [ ] 浏览器只访问 Next.js 产品边界；内部 Worker/数据库/Qdrant 不暴露公网
- [ ] 对象 key 与日志不泄露原文

## C. 可靠性

- [ ] worker crash / SIGTERM drain 可恢复
- [ ] lease / heartbeat / reaper 有自动化测试且近期绿
- [ ] dead / stuck / orphan 可巡检（`lifecycle:inspect`）
- [ ] 激活与 cleanup 可重复执行
- [ ] 旧 job 不能覆盖新 desired version

## D. 工程

- [ ] API / Web / PostgreSQL / Qdrant / 真实文件相关测试在发布流水线绿
- [ ] production build 通过
- [ ] migration 与 rollback/runbook 完整
- [ ] 文档生命周期只有 DBOS workflow 一条生产执行路径
- [ ] CI deterministic / isolation gate 通过；release gate 按发布流程执行或书面豁免
- [ ] web / worker / migrator / ops 四张镜像通过 Trivy `HIGH/CRITICAL` 门禁，并使用 digest manifest
- [ ] 关键控制面操作可在 audit 页面查询并导出 CSV

## E. 交付

- [ ] 客户可使用自有数据库、模型 endpoint 与密钥
- [ ] 文档存储使用目标环境已验证的共享卷/PVC；仅在受支持 adapter 交付并验收后承诺客户对象存储
- [ ] 全新安装、升级、回滚、备份恢复均按 runbook 演练通过
- [ ] 质量报告、已知限制、SLA/SLO、问题升级路径随版本交付
- [ ] [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md) 已填写且结论为 **GO**
- [ ] 目标部署的阻断项清零；非阻断项已写入已知限制并有负责人或处置结论

## F. 明确仍可后置（不阻塞宣称，但须写入已知限制）

以下与路线图后置项一致，**未完成不否决** production-ready，
但发布说明必须写明：

- [ ] （可选）SBOM、镜像签名与 provenance
- [ ] （可选）OIDC / SSO 与组织同步
- [ ] （可选）Workspace 成本分析面板（token/model usage 原始采集仍应保留）
- [ ] （可选）Helm HPA / PDB / NetworkPolicy 硬化
- [ ] （可选）MinIO/S3 一等对象后端
- [ ] （可选）archive 全字段固化与线上延迟环境基线

若客户合同、采购安全基线或部署环境明确要求上述某项，该项自动成为该次交付的门禁；
这不把它提升为所有受控试点的通用门禁。

## 结论栏

| 项 | 值 |
|---|---|
| 版本 / commit | |
| 清单完成日期 | |
| 是否允许对外宣称 production-ready | 是 / 否 |
| 依据的 go 报告路径 | |
| 签署人 | |

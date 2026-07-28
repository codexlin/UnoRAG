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
- [ ] 浏览器只访问控制面；FastAPI 写路径对边缘不可达
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
- [ ] FastAPI ingest 写路径永久 410；生产仅 lifecycle_worker 入库（无 ARQ）
- [ ] L7 CI gate 通过；release gate 按发布流程执行或书面豁免

## E. 交付（L8 + L9）

- [ ] 客户可使用自有数据库、对象存储、模型 endpoint 与密钥
- [ ] 全新安装、升级、回滚、备份恢复均按 runbook 演练通过
- [ ] 质量报告、已知限制、SLA/SLO、问题升级路径随版本交付
- [ ] [`pilot-go-no-go-template.md`](./pilot-go-no-go-template.md) 已填写且结论为 **GO**
- [ ] 目标部署的阻断项清零；非阻断项已写入已知限制并有负责人或处置结论

## F. 明确仍可后置（不阻塞宣称，但须写入已知限制）

以下与路线图 §17 / L8 后置一致，**未完成不否决** production-ready，
但发布说明必须写明：

- [ ] （可选）完整 audit 页面 / CSV 导出
- [ ] （可选）SBOM 生成与依赖/镜像 CVE 扫描流水线
- [ ] （可选）OIDC / SSO 与组织同步
- [ ] （可选）Workspace 成本分析面板（token/model usage 原始采集仍应保留）
- [ ] （可选）Helm HPA / PDB / NetworkPolicy 硬化
- [ ] （可选）镜像 digest 锁定与私有 registry
- [ ] （可选）MinIO/S3 一等对象后端
- [ ] （可选）archive 全字段固化与线上延迟环境基线

若客户合同、采购安全基线或部署环境明确要求上述某项，该项自动成为该次交付的门禁；这不把它提升为所有受控试点的通用 P0。

## 结论栏

| 项 | 值 |
|---|---|
| 版本 / commit | |
| 清单完成日期 | |
| 是否允许对外宣称 production-ready | 是 / 否 |
| 依据的 go 报告路径 | |
| 签署人 | |

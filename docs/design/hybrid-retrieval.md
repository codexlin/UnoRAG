# UnoRAG 混合检索演进设计

> 状态：设计提案，尚未进入交付承诺。
>
> 关联：[架构](../ARCHITECTURE.md) · [可观测性目标架构](./observability.md) · [评测与发布](../RELEASE.md)

## 1. 目的

本文只讨论 UnoRAG 的词法检索、稠密检索和融合路径。它从可观测性设计中独立出来，因为检索后端、
ACL 安全和相关性评测属于检索架构决策，不应和日志、指标或 Trace 的部署绑在一起。

目标是在不牺牲租户/ACL 隔离、引用正确性和可回滚能力的前提下，逐步解决应用层 BM25 的容量和延迟
问题。任何迁移都必须由真实黄金集和隔离测试驱动，不能只根据组件能力宣称质量提升。

## 2. 当前实现

开启 hybrid 时，当前检索路径大致为：

1. 对问题执行稠密向量检索；
2. 从 Qdrant `scroll` 当前调用者可见的语料，最多读取 `corpusLimit`；
3. 在 Node.js 请求进程中分词并重建 BM25 统计；
4. 执行词法检索并与稠密结果做 RRF 融合；
5. 经过 ACL/版本约束、可选 rerank 和 judge 后进入回答。

该实现的优点是逻辑清楚、权限范围可见、无需维护第二套持久索引。问题是每次查询都可能重复拉取和
计算语料，CPU、内存和延迟随可见语料增长，并受 `corpusLimit` 截断影响。

在改变实现前应先补齐这些指标：

- ACL 过滤前后候选数量；
- 实际读取语料数与 `corpusLimit` 截断次数；
- BM25 构建、打分、dense、fusion、rerank 各阶段耗时；
- dense/sparse 各自命中、融合增益和最终引用覆盖；
- 按文库规模统计的 P50/P95 和进程内存峰值。

这些指标遵循 [可观测性目标架构](./observability.md) 的低基数要求，不把租户、文库或文档 ID 放入
Prometheus label。

## 3. ACL 安全边界

BM25 语料不是只由 `library_id` 和 active generation 决定。实际可见集合还可能受以下条件影响：

- organization 和 workspace；
- principal、用户组和文档 ACL；
- document allowlist；
- 查询时 filters；
- active document version / generation。

因此，以 `(library_id, active_generation_ids)` 作为缓存键会产生授权污染风险：高权限主体构建的索引
可能被低权限主体复用。即使最终结果还有过滤，这种缓存也会造成错误排序、侧信道和未来维护中的越权
隐患，不能被视为低风险优化。

若仍评估应用层缓存，必须同时满足：

1. 缓存键包含稳定、规范化的 authorization fingerprint 和检索 filters；
2. 命中结果在返回前再次执行强制 tenant/workspace/ACL/version 校验；
3. active generation、ACL、用户组、allowlist 和文档删除变化都能可靠失效；
4. 有 TTL、LRU、内存上限、防缓存击穿和多实例一致性方案；
5. 跨用户组、跨 Workspace 和 ACL 变更测试证明零泄漏；
6. 复杂度和实际收益经基准测试后仍优于直接迁移稀疏检索。

在这些条件满足前，保持当前按请求构建的正确路径比引入不安全缓存更合理。

## 4. 候选演进路线

### 4.1 路线 A：受控的应用层 BM25

近期可以保留当前实现，优先做可观测和有界化：

- 明确 `corpusLimit` 截断并在调试信息中暴露降级原因；
- 对超大可见语料采用明确的 fallback 或拒绝策略，而不是静默损失召回；
- 复用安全范围完全一致的短生命周期索引前，先完成 authorization fingerprint 设计；
- 通过 feature flag 控制缓存，并保留立即关闭和回退能力。

该路线适合首发客户语料规模尚未证明需要架构迁移的阶段，但不是无限扩展方案。

### 4.2 路线 B：Qdrant 原生稀疏向量

长期候选是在 ingest 阶段同时写入 dense 和 sparse vector，在 Qdrant 服务端执行 prefetch 与 RRF/DBSF
融合，去掉查询时 `listCorpus` 和内存重建 BM25。

潜在收益：

- 稀疏索引随文档写入增量维护；
- 不再每次查询拉取可见语料并重算；
- dense、sparse 和融合在同一检索后端执行；
- 更适合多实例 Web 和更大文库。

必须正视的风险：

- ingest、索引 schema、重索引、回滚和 generation cleanup 都需要同步改造；
- 中文分词和稀疏编码器质量可能与当前 BM25 不同；
- collection-wide IDF 会受同集合其他租户语料统计影响。Payload filter 可以阻止文本越权返回，但
  不能天然提供“每租户独立 IDF”，相关性排序仍可能被其他租户语料分布影响；
- sparse payload/filter 必须和 dense 路径使用完全相同的 organization/workspace/ACL/version 条件；
- 索引体积、写入耗时和 reindex 时间会增加。

collection-wide IDF 目前首先按**相关性隔离风险**处理；若评测发现可推断性或侧信道问题，应升级为
安全问题，并评估按租户/Workspace 分集合或关闭服务端 IDF。

## 5. 双轨迁移

建议保留后端开关：

```text
HYBRID_BACKEND=application_bm25
HYBRID_BACKEND=qdrant_sparse
```

迁移采用 shadow/canary，而不是一次性替换：

1. ingest 双写 sparse，但线上仍使用 application BM25；
2. 离线 shadow 查询并记录两条路径的候选差异，不改变用户答案；
3. 在测试 Workspace 开启 qdrant sparse；
4. 通过门禁后按 Workspace 灰度；
5. 保留一键回退 application BM25，直到至少一个完整发布周期稳定。

不得把原始问题、文档正文或跨租户候选写入对比日志。Shadow 结果仍受调用者 ACL 约束。

## 6. 评测与发布门禁

现有 `testdata/ab/golds.jsonl` 和真实文件矩阵是检索评测的事实源，应扩展而不是在 Langfuse 或其他工具
里另建一套漂移数据。Langfuse 可以导入这些用例并记录实验，但仓库中的版本化黄金集仍是发布门禁。

至少覆盖：

- 中文事实、同义词、缩写、编号和精确词项；
- 表格行、单位、比较符号和跨页表；
- dense 独有命中、lexical 独有命中和融合冲突；
- 拒答 precision、citation coverage 和 citation correctness；
- ACL、用户组、allowlist、跨 Workspace、跨 organization 零泄漏；
- 文档替换、active generation 切换、删除和 cleanup 后不可召回旧版本；
- 小、中、大文库下的 P50/P95、CPU、内存、Qdrant 存储和写入开销。

发布熔断项：

1. 任意跨租户、跨 Workspace 或 ACL 泄漏；
2. active 版本约束失效或删除内容仍可召回；
3. 拒答 precision、table 执行准确率或 citation coverage 低于当前基线；
4. P95、索引耗时或资源开销超过事先批准的预算；
5. qdrant sparse 与 application BM25 之间无法可靠回退。

Qdrant sparse 只有在真实黄金集、隔离测试和容量基准都通过后，才能成为默认路径。组件宣称支持
稀疏向量、IDF 或服务端 RRF，不等于 UnoRAG 的中文质量、ACL 和多租户模型已经得到证明。

## 7. 当前决策

- 继续以 `application_bm25` 作为当前基线；
- 不实施仅按 library/generation 的共享缓存；
- 先补阶段指标、截断信号和真实容量基准；
- 将 Qdrant sparse 作为独立项目，通过 feature flag、双写、shadow 和灰度验证；
- 在证据充分前，不承诺某一后端必然提升质量或适用于所有客户规模。

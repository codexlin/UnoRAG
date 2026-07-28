# Ask 消融（最小骨架）

> **实验工具，不是发布门禁。** 私有化能否上线看 `private-stability.sh` 与完整栈验收。

## 与稳定性的分工

| 脚本 | 问题 | 失败含义 |
|------|------|----------|
| `private-stability.sh` | 系统能不能发布？ | 必须全绿 |
| `run_ablation_matrix.py` | 某能力有没有价值？ | 变差是实验结果，不是发布红灯 |

## 保留能力

- 用例字段：`category`、`policy_variant`、gold ids、`expected_answer_points`
- 配对比较：同一道题跑 A0 + 适用变体
- gold 标注缺失观察值 → **失败**（不允许空证据蒙混）
- 无可匹配用例的 runnable 变体 → **报错退出**
- 展开文件写在系统临时目录
- 报告只含原始 pass/fail/p95，**无**自动 keep/delete

## 变体状态

| ID | 状态 |
|----|------|
| A0 | 可跑 |
| A5 / A6 | 可跑（需对应 category） |
| A3 / A4 | `not_evaluable`（A0 未开 hybrid/rerank） |
| A1 / A2 / A7 / A8 | 需图钩子 |

## 运行

```bash
cd apps/api
uv run python scripts/run_ablation_matrix.py \
  --cases tests/eval/ablation_cases.jsonl \
  --report-out /tmp/unorag-ablation.json
```

Live 消融与真实数据集就绪后，再研究 rerank → hybrid → retry → 复杂图节点。

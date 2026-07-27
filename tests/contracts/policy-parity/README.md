# Py↔JS policy parity contract

证明 `policy_profiles.py` 与 `ask-policy.mjs` / `document-policy.mjs` 对**同一输入**产出一致，而不是各自单测绿。

**不做** codegen / 共享包；只跑共享 fixtures + 双边公开函数。

## 布局

| 路径 | 作用 |
|------|------|
| `fixtures.json` | 共享用例（Ask resolve / legacy migrate / Document / override keys） |
| `../../scripts/policy_parity_py.py` | Python 侧标准化 JSON 输出 |
| `../../scripts/policy_parity_js.mjs` | JS 侧标准化 JSON 输出 |
| `../../scripts/compare_policy_parity.py` | 跑两边并比较（剥掉 `runtime` 字段） |

## 怎么跑

在仓库根目录 `MeriKnow/`：

```bash
# 全量比较（推荐）
python3 scripts/compare_policy_parity.py

# 单边 dump
uv run --directory apps/api python ../../scripts/policy_parity_py.py
node scripts/policy_parity_js.mjs

# 既有单测（各边行为，不替代 parity）
uv run --directory apps/api pytest tests/test_policy_profiles.py tests/test_policy_parity_contract.py -q
pnpm --dir apps/web test -- tests/policy-parity.test.mjs
```

CI：`.github/workflows/ci.yml` → `eval-gates.yml` 的 `policy-parity` job。

## 改映射时

1. 双边改 `policy_profiles.py` ↔ `ask-policy.mjs` / `document-policy.mjs`
2. 若语义变化，更新或追加 `fixtures.json`
3. 跑 `python3 scripts/compare_policy_parity.py` 必须绿

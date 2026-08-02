# TypeScript Policy Contract

`fixtures.json` contains deterministic Ask and document-policy cases shared by the
current TypeScript policy tests.

Run from the repository root:

```bash
pnpm test
```

The retired Python runtime no longer participates in this contract. When policy
semantics change, update the public resolver, fixture expectations, and tests in the
same commit.

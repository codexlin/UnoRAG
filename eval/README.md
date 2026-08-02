# Evaluation Assets

`reference/` preserves the 40-case quality corpus and 8-case ablation corpus from
the retired Python runtime. The data remains useful for rebaselining, but its old
stub runner and scores are not a release gate for the native TypeScript runtime.

Current executable coverage lives in `apps/web/tests/ts-core/` and includes routing,
refusal, table execution, citation, parser, Qdrant scope, ACL, lifecycle, and DBOS
contracts. A live golden runner will be rebuilt after the local Docker cutover, using
real indexed fixtures and product HTTP endpoints. Until then, CI must not report the
reference baseline as a current quality pass.

The hard release fuses remain unchanged:

- cross-organization, cross-workspace, and ACL leakage: zero;
- inactive or deleted generation recall: zero;
- unsupported answers must refuse;
- table answers must retain contributing citations.

# UnoRAG 试点反馈模板

本模板只记录版本、场景、结论与证据引用。不要粘贴客户文档、问题、答案、Prompt、凭据或个人信息。

## 版本边界

- Release / commit:
- Deployment ID:
- 配置摘要与模型/Parser 版本:
- 试点起止时间:
- Admin / Editor / Viewer 人数（仅数量）:

## 场景结论

| Scenario ID | Result | Evidence reference | Notes |
|---|---|---|---|
| upload-retrieve-ask | PASS / FAIL / BLOCKED | report path / trace ID | |
| replace-and-failed-replace | PASS / FAIL / BLOCKED | report path / job ID | |
| permission-boundary | PASS / FAIL / BLOCKED | report path / audit ID | |
| provider-recovery | PASS / FAIL / BLOCKED | report path / alert ID | |
| backup-restore | PASS / FAIL / BLOCKED | report path / backup ID | |

## 决策

- Incident references:
- Known limitations:
- Decision: `GO` / `CONDITIONAL_GO` / `NO_GO`
- Decision owner:
- Approved at:

机器可读归档应符合 [`pilot-feedback.schema.json`](../../scripts/acceptance/pilot-feedback.schema.json)，并与本次 Release Gate 报告一起保存。

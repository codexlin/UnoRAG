# unsupported/

本目录文件**不应**被成功入库，用于验证上传拒收。

| 文件 | 期望 |
|------|------|
| `sample.html` | 413/400 类错误，提示 unsupported file type |

CSV / XLSX 已进入生产解析路径，正例放在对应格式目录；本目录只保留当前明确拒收的格式。

# unsupported/

本目录文件**不应**被成功入库，用于验证上传拒收。

| 文件 | 期望 |
|------|------|
| `sample.html` | 413/400 类错误，提示 unsupported file type |
| `notes.csv` | 同上（xlsx/csv 尚未进生产路径） |

Phase 2+ 若接入 HTML/表格文件，再把这里的样例迁到正式 fixture。

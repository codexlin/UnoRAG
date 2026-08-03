# unsupported/

本目录文件**不应**被成功入库，用于验证上传拒收。

| 文件 | 期望 |
|------|------|
| `notes.csv` | 400 类错误，提示 unsupported file type |
| `sample.html` | 413/400 类错误，提示 unsupported file type |

CSV / XLSX / HTML 当前均不在生产上传白名单中。若未来增加结构化表格导入，必须先补
独立解析契约、真实入库测试和发布门禁，不能仅放宽扩展名校验。

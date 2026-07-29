# 测试数据集 (`testdata/`)

用于 **ingest 上传 + 问答手工/回归** 的核心 fixture。  
上传支持：`txt` / `md` / `pdf` / `docx` / `csv` / `xlsx`
（单文件硬上限 50MB；本集均远小于该上限）。

设计原则：

1. **金句跨文件唯一**（见下方对照表），避免多文档误命中。
2. **一种能力一份文件**，页数少、体积小。
3. `unsupported/` 只测拒收，不要当正例上传。

## 目录

```
testdata/
├── README.md
├── md/handbook.md
├── txt/plain.txt
├── pdf/
│   ├── leave-digital.pdf       # 可选中文字，3 页
│   ├── leave-scanned.pdf       # 扫描件（无文字层）
│   ├── manual-with-figure.pdf  # 图文混排
│   └── messy-headers.pdf       # 页眉页脚 + 多页不同金句
├── docx/
│   ├── quote-table.docx        # 真表格报价单
│   └── policy-headings.docx    # Heading 1/2 样式
├── csv/
│   └── notes.csv               # 原生结构化表格
└── unsupported/
    └── sample.html              # HTML → 期望拒收
```

## 金句对照（勿改冲突）

| 文件 | 独占锚点 |
|------|----------|
| `md/handbook.md` | `须于返岗后三个工作日内补交`；`基本工资×80%`；`按自然月二十五日发放` |
| `txt/plain.txt` | `蓝鲸游过赤道时水温恰好为二十六点七度`；`罚款200元` |
| `pdf/leave-digital.pdf` | `须于返岗后五个自然日内将原件交至人力资源前台`；`HR-POL-2026-003`；`2026年3月1日` |
| `pdf/leave-scanned.pdf` | 无文字层 → 期望 `needs_ocr` / `partial`（勿当可检索金句） |
| `pdf/manual-with-figure.pdf` | `见图注：设备须断电`；`内线119` |
| `pdf/messy-headers.pdf` | 页眉/页脚 `内部资料·勿外传`；金句 A/B/C（摩尔斯 / 灯塔 / 量子） |
| `docx/quote-table.docx` | `甲公司` + `120000`；`36个月` |
| `docx/policy-headings.docx` | `当哈雷彗星下次回归时人类已在火星建立永久基地` |
| `csv/notes.csv` | `差旅` + `3200`；`北极狐在极昼时会把影子藏进雪窝` |
| `unsupported/*` | 仅拒收，不参与检索断言 |

## 期望问法（手工测 / 日后写 eval）

### `md/handbook.md`
| 问法 | 期望片段 |
|------|----------|
| 第3章讲什么？ | 请假制度 |
| 年假薪资怎么扣？ | 不扣 |
| 返岗后几天内补交材料？ | 三个工作日 |
| 基本工资哪天发？ | 二十五日 |

### `txt/plain.txt`
| 问法 | 期望片段 |
|------|----------|
| 办公区吸烟怎么罚？ | 罚款200元 |
| 文档里的唯一金句？ | 二十六点七度 |

### `pdf/leave-digital.pdf`
| 问法 | 期望片段 |
|------|----------|
| 第2页补交材料的规定？ | 五个自然日 / 人力资源前台 |
| 文件编号？ | HR-POL-2026-003 |
| 施行日期？ | 2026年3月1日 |

### `pdf/leave-scanned.pdf`
| 问法 | 期望 |
|------|------|
| 能否直接抽字？ | 无 MinerU/OCR：显式 fail（错误含 extractable/MinerU）；启用 `MINERU_ENABLED`+服务或 `MINERU_USE_FAKE` → `ready`/`partial`，`parser_report.backend=mineru` |

### `pdf/manual-with-figure.pdf`
| 问法 | 期望片段 |
|------|----------|
| 图旁边的注意事项？ | 见图注：设备须断电 |
| 漏电怎么办？ | 急停 / 内线119 |

### `pdf/messy-headers.pdf`
| 问法 | 期望片段 |
|------|----------|
| 页眉写了什么？ | 内部资料·勿外传（理想：正文检索少被页眉污染） |
| 第三页主题？ | 知识产权归属 |
| 第一页唯一金句？ | 紫藤花架 / 摩尔斯 |

### `docx/quote-table.docx`
| 问法 | 期望片段 |
|------|----------|
| 甲公司总价？ | 120000 |
| 质保多久？ | 36个月 |

### `docx/policy-headings.docx`
| 问法 | 期望片段 |
|------|----------|
| 二级标题有哪些？ | 账号与权限管理、数据分类分级 |
| 蓝色/加粗金句？ | 哈雷彗星 / 火星 |

### `csv/notes.csv`
| 问法 | 期望片段 |
|------|----------|
| 差旅金额是多少？ | 3200 |
| 差旅备注里的唯一金句？ | 北极狐在极昼时会把影子藏进雪窝 |

## 建议用法

```bash
# 产品上传走控制面（FastAPI /v1/ingest* 永久 410）
# 例：登录 Web UI 后 POST /api/libraries/{id}/documents
# 或使用已有 seed / lifecycle 路径；勿再 curl FastAPI ingest。
```

黄金集已覆盖部分本目录文件：`ingest_chunk` / `retrieval`（**Recall@3**）以及
`ingest_http`（plain→ready、leave-scanned→failed、sample.html→400）。

体积参考：本集 PDF/DOCX 均约数 KB～数十 KB，远低于 50MB 上限。

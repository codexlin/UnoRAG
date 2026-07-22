# MeriKnow API

FastAPI + LangChain + LangGraph。图路径：`rewrite → retrieve → judge → (retry) → generate | refuse`。

## 前置：Qdrant

仓库根目录：

```bash
docker compose up -d
curl -s http://localhost:6333/readyz
```

`.env` 中 `QDRANT_URL=http://localhost:6333`（与 compose 一致）。

## 本地启动

```bash
cd apps/api
cp .env.example .env   # 首次
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

- 健康检查：<http://localhost:8000/health>
- 问答：`POST http://localhost:8000/v1/ask`
- 入库（live）：`POST http://localhost:8000/v1/ingest`

```bash
curl -s http://localhost:8000/health
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr","session_id":"demo-1"}'
```

Stub 拒答自测：问题含「无命中」或「弱相关」。

多轮（同 `session_id`）：

```bash
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"那逾期呢？","library_id":"lib-hr","session_id":"demo-1"}'
```

响应 `retrieval_debug.rewrite` 在追问时应为 `history`。

## 环境变量

见 `.env.example`。要点：

| 变量 | 说明 |
|------|------|
| `ASK_MODE` | 默认 `live`；缺密钥或 Qdrant 不可达时硬失败（503），不降级 stub。`stub` 仅测试 |
| `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` | OpenAI-compatible 密钥 |
| `OPENAI_BASE_URL` | 默认 DashScope compatible-mode |
| `CHAT_MODEL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 默认 qwen-plus / text-embedding-v3 / 1024 |
| `QDRANT_URL` / `QDRANT_COLLECTION` | 向量库（默认 `http://localhost:6333`） |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | 默认 500 / 80 |
| `ANSWER_MIN_SCORE` | 弱相关拒答阈值；`0` 关闭 |
| `MAX_RETRIEVE_RETRIES` | judge 后最多重试次数（默认 1） |
| `RERANK_ENABLED` | 默认 `false`；开启后 dense → `/reranks` |
| `RERANK_BASE_URL` / `RERANK_MODEL` / `RERANK_TOP_K` | DashScope-compatible rerank |
| `SESSION_MEMORY_ENABLED` | 默认 `true`；同 session 短记忆 rewrite |
| `SESSION_MEMORY_MAX_TURNS` | 保留轮数（默认 6） |
| `STUB_INGEST_SIMULATE` | 默认 `false`；仅 `ASK_MODE=stub` 且为 true 时模拟入库 |

## Live 样例入库

```bash
uv run python scripts/ingest_sample.py
```

## 测试

```bash
uv run pytest
```

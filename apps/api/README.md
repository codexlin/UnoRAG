# MeriKnow API

FastAPI + LangChain + LangGraph。图路径：`rewrite → retrieve → judge → (retry) → generate | refuse`。

## 本地启动

```bash
cd apps/api
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
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr"}'
```

Stub 拒答自测：问题含「无命中」或「弱相关」。

## 环境变量

见 `.env.example`。要点：

| 变量 | 说明 |
|------|------|
| `ASK_MODE` | `stub` / `live`；live 缺密钥或 Qdrant 不可达时降级 stub |
| `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` | OpenAI-compatible 密钥 |
| `OPENAI_BASE_URL` | 默认 DashScope compatible-mode |
| `CHAT_MODEL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 默认 qwen-plus / text-embedding-v3 / 1024 |
| `QDRANT_URL` / `QDRANT_COLLECTION` | 向量库 |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | 默认 500 / 80 |
| `ANSWER_MIN_SCORE` | 弱相关拒答阈值；`0` 关闭 |
| `MAX_RETRIEVE_RETRIES` | judge 后最多重试次数（默认 1） |

## Live 样例入库

```bash
uv run python scripts/ingest_sample.py
```

## 测试

```bash
uv run pytest
```

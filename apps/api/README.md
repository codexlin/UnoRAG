# MeriKnow API

FastAPI + LangChain + LangGraph。Phase 2 起步：健康检查、问答 stub 图、CORS。

## 本地启动

```bash
cd apps/api
uv sync          # 或: pip install -e .
uv run uvicorn app.main:app --reload --port 8000
```

健康检查：<http://localhost:8000/health>  
问答 stub：`POST http://localhost:8000/v1/ask`

```bash
curl -s http://localhost:8000/health
curl -s -X POST http://localhost:8000/v1/ask \
  -H 'content-type: application/json' \
  -d '{"question":"病假需要在几天内补交证明？","library_id":"lib-hr"}'
```

## 环境变量

见 `.env.example`。默认 `ASK_MODE=stub`，无需模型密钥即可返回示例答案与引用。

## 后续

- 接入真实检索（Qdrant）与 LLM（OpenAI-compatible / DashScope）
- 扩展 LangGraph：改写 → 检索 → 判断 → 重试 → 生成 → 校验
- Postgres 元数据（SQLAlchemy + Alembic，不用 Prisma）

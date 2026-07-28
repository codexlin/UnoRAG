# UnoRAG RAG Data Plane + lifecycle worker image.
# Build from repository root:
#   docker build -f deploy/docker/api.Dockerfile -t unorag-api:local .

FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1 \
	UV_COMPILE_BYTECODE=1 \
	UV_LINK_MODE=copy \
	PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /usr/local/bin/uv

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl \
	&& rm -rf /var/lib/apt/lists/*

COPY apps/api/pyproject.toml apps/api/uv.lock ./
# --no-cache: do not leave /root/.cache/uv in the image (~hundreds of MB).
RUN uv sync --frozen --no-dev --no-install-project --no-cache \
	&& rm -f /usr/local/bin/uv

COPY apps/api/app ./app
COPY apps/api/migrations ./migrations
COPY apps/api/scripts ./scripts
COPY contracts ./contracts

EXPOSE 8000

# Default: FastAPI. Compose overrides command for lifecycle-worker / migrate.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

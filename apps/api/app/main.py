from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import archive, ask, health, libraries, retrieve
from app.security.internal_context import InternalBodyDigestMiddleware, require_internal_context
from app.services.active_generations import probe_active_generation_store
from app.services.metadata import get_metadata_store, probe_metadata_store, reset_metadata_store
from app.settings import get_settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_application: FastAPI):
	settings = get_settings()
	reset_metadata_store()
	ok, backend, detail = probe_metadata_store(settings)
	if not ok:
		raise RuntimeError(
			f"MeriKnow requires Postgres metadata (backend={backend}): {detail}. "
			"Run `docker compose up -d` and set DATABASE_URL."
		)
	# Force metadata store init (no demo library seed)
	get_metadata_store(settings)
	logger.info("startup.metadata_ok backend=%s detail=%s", backend, detail)
	active_gate_ok, active_gate_detail = probe_active_generation_store(settings)
	if not active_gate_ok:
		raise RuntimeError(
			f"active generation gate is unavailable: {active_gate_detail}. "
			"Run `uv run python scripts/apply_rag_migrations.py`."
		)
	logger.info(
		"startup.active_generation_gate enabled=%s detail=%s",
		settings.active_generation_gate_enabled,
		active_gate_detail,
	)
	yield


def create_app() -> FastAPI:
	settings = get_settings()
	application = FastAPI(
		title=settings.app_name,
		version="0.4.1",
		docs_url="/docs",
		redoc_url="/redoc",
		lifespan=lifespan,
	)
	application.add_middleware(
		CORSMiddleware,
		allow_origins=settings.cors_origin_list,
		allow_credentials=True,
		allow_methods=["*"],
		allow_headers=["*"],
	)
	application.add_middleware(InternalBodyDigestMiddleware)
	application.include_router(health.router)
	internal_dependencies = [Depends(require_internal_context)]
	application.include_router(
		ask.router,
		prefix=settings.api_prefix,
		dependencies=internal_dependencies,
	)
	application.include_router(
		retrieve.router,
		prefix=settings.api_prefix,
		dependencies=internal_dependencies,
	)
	application.include_router(
		libraries.router,
		prefix=settings.api_prefix,
		dependencies=internal_dependencies,
	)
	application.include_router(
		archive.router,
		prefix=settings.api_prefix,
		dependencies=internal_dependencies,
	)
	return application


app = create_app()

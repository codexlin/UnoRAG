from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import ask, health, libraries
from app.settings import get_settings


def create_app() -> FastAPI:
	settings = get_settings()
	application = FastAPI(
		title=settings.app_name,
		version="0.3.0",
		docs_url="/docs",
		redoc_url="/redoc",
	)
	application.add_middleware(
		CORSMiddleware,
		allow_origins=settings.cors_origin_list,
		allow_credentials=True,
		allow_methods=["*"],
		allow_headers=["*"],
	)
	application.include_router(health.router)
	application.include_router(ask.router, prefix=settings.api_prefix)
	application.include_router(libraries.router, prefix=settings.api_prefix)
	return application


app = create_app()

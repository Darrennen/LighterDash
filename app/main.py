"""Lighter Analyst Cockpit — FastAPI backend entry point.

Run with:
    uvicorn app.main:app --reload
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db import init_db
from app.routes import api
from app.services.collector import collector_loop

log = logging.getLogger("lighter")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)

ROOT = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the background collector on startup; cancel on shutdown."""
    await init_db()
    log.info("DB initialised at %s", settings.DB_PATH)

    task = asyncio.create_task(collector_loop(), name="collector")
    log.info("Collector loop started (interval=%ss)", settings.COLLECT_INTERVAL)
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        log.info("Collector stopped")


app = FastAPI(
    title="Lighter Analyst Cockpit",
    description="Local backend that aggregates Lighter.xyz market data.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local tool; tighten for deployment
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api.router, prefix="/api", tags=["data"])

app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(ROOT / "templates" / "index.html")


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok", "collector_interval_s": settings.COLLECT_INTERVAL}

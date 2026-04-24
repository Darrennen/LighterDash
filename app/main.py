"""Lighter Analyst Cockpit — FastAPI entry point.

Local:  uvicorn app.main:app --reload
Vercel: handled via api/index.py
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.routes import api, explorer as explorer_routes, lit as lit_routes

log = logging.getLogger("lighter")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)

ROOT = Path(__file__).resolve().parent.parent

import os

app = FastAPI(
    title="Lighter Analyst Cockpit",
    description="Aggregates Lighter.xyz market data.",
    version="0.1.0",
    # Disable interactive API docs in production; set ENABLE_DOCS=1 to re-enable
    docs_url="/docs" if os.getenv("ENABLE_DOCS") == "1" else None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "HEAD", "OPTIONS"],  # read-only — no POST/PUT/DELETE
    allow_headers=["*"],
)

app.include_router(api.router, prefix="/api", tags=["data"])
app.include_router(lit_routes.router, prefix="/api/lit", tags=["lit"])
app.include_router(explorer_routes.router, prefix="/api/explorer", tags=["explorer"])
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(ROOT / "templates" / "index.html")


@app.get("/lit", include_in_schema=False)
async def lit_page():
    return FileResponse(ROOT / "templates" / "lit.html")


@app.get("/explorer", include_in_schema=False)
async def explorer_page():
    return FileResponse(ROOT / "templates" / "explorer.html")


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}

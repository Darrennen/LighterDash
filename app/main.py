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

from app.routes import api

log = logging.getLogger("lighter")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)

ROOT = Path(__file__).resolve().parent.parent

app = FastAPI(
    title="Lighter Analyst Cockpit",
    description="Aggregates Lighter.xyz market data.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    return {"status": "ok"}

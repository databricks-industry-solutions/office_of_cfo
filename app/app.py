"""The Self-Healing Close — Reconciliation & Adjustments app (Act 4).

FastAPI backend that reads the governed close (Unity Catalog serving/DQ tables)
and writes adjustments to Lakebase (system of record), flowing them back to the
lake so the real-time trial balance and live reconciliation reflect them.
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from server.config import set_current_industry, set_user_token
from server.demo_calendar import month_offset, set_browser_today
from server.lakebase import pool
from server.routes import ai_roi
from server.routes import (
    adhoc_analysis, audit, bridge_analysis, close, close_support, competitor_search, datasources, deployment,
    exposure, fpa_commentary, genie, historical, insights, kpis, lineage_quality,
    market_insights, personas, scenario, statements, tasks, treasury, variance_dashboard,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Open the Lakebase pool, but don't let a not-yet-attached database take the
    # whole app down: the Unity Catalog-driven views still render. Lakebase-backed
    # endpoints degrade gracefully until the database resource is attached.
    try:
        pool.open(wait=True, timeout=20.0)
    except Exception as e:  # noqa: BLE001
        print(f"[startup] Lakebase pool not ready yet: {e}")
    yield
    try:
        pool.close()
    except Exception:  # noqa: BLE001
        pass


app = FastAPI(title="The Self-Healing Close", lifespan=lifespan)


@app.middleware("http")
async def _industry_context(request: Request, call_next):
    # Resolve the active industry from the X-Industry header into a ContextVar so
    # every route (and the Lakebase pool router) reads the right industry's data.
    set_current_industry(request.headers.get("X-Industry"))
    set_browser_today(request.headers.get("X-Demo-Today"))
    # On-behalf-of-user: Databricks Apps forwards the signed-in user's downscoped
    # OAuth token here when the app has user API scopes. Stash it so warehouse
    # reads run as the viewer (their UC grants), not the app service principal.
    set_user_token(request.headers.get("X-Forwarded-Access-Token"))
    response = await call_next(request)
    response.headers["X-Demo-Month-Offset"] = str(month_offset())
    return response


app.include_router(close.router, prefix="/api")
app.include_router(genie.router, prefix="/api")
app.include_router(insights.router, prefix="/api")
app.include_router(audit.router, prefix="/api")
app.include_router(tasks.router, prefix="/api")
app.include_router(personas.router, prefix="/api")
app.include_router(kpis.router, prefix="/api")
app.include_router(datasources.router, prefix="/api")
app.include_router(lineage_quality.router, prefix="/api")
app.include_router(exposure.router, prefix="/api")
app.include_router(close_support.router, prefix="/api")
app.include_router(competitor_search.router, prefix="/api")
app.include_router(statements.router, prefix="/api")
app.include_router(variance_dashboard.router, prefix="/api")
app.include_router(bridge_analysis.router, prefix="/api")
app.include_router(fpa_commentary.router, prefix="/api")
app.include_router(deployment.router, prefix="/api")
app.include_router(historical.router, prefix="/api")
app.include_router(scenario.router, prefix="/api")
app.include_router(treasury.router, prefix="/api")
app.include_router(market_insights.router, prefix="/api")
app.include_router(adhoc_analysis.router, prefix="/api")
app.include_router(ai_roi.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve the built React frontend (frontend/dist) when present.
_frontend = os.path.join(os.path.dirname(__file__), "frontend", "dist")
if os.path.isdir(_frontend):
    app.mount("/assets", StaticFiles(directory=os.path.join(_frontend, "assets")), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = os.path.join(_frontend, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(_frontend, "index.html"))

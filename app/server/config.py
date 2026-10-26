"""Environment + auth configuration (dual-mode: local CLI profile vs deployed SP).

Also owns per-request industry resolution: each request carries an ``X-Industry``
header (set into a ContextVar by middleware in app.py). Schema names are exposed
as proxy objects (``SRV``/``CLOSE_FQ``/``OPS_FQ``/``RAW_FQ``) that resolve to the
active industry's schema set at f-string interpolation time, so route queries need
no per-call plumbing. Set ``CFO_MULTI_INDUSTRY=0`` to fall back to the single-
industry baseline schemas ({catalog}.baseline_*).

Workspace-specific values (catalog, warehouse, Genie spaces, Lakebase) arrive as
environment variables: the bundle sets them in resources/app.app.yml. Nothing
here defaults to a particular workspace.
"""
import contextvars
import os
import re
from datetime import date

from databricks.sdk import WorkspaceClient

from .industry import DEFAULT_INDUSTRY, resolve_industry

IS_DATABRICKS_APP = bool(os.environ.get("DATABRICKS_APP_NAME"))

# Unity Catalog targets. MULTI_CATALOG holds every industry's schemas; the
# single-industry baseline lives in the same catalog unless DATABRICKS_CATALOG
# points elsewhere.
MULTI_CATALOG = os.environ.get("MULTI_CATALOG", "office_of_cfo")
CATALOG = os.environ.get("DATABRICKS_CATALOG", MULTI_CATALOG)
CLOSE_SCHEMA = os.environ.get("CLOSE_SCHEMA", "baseline_close")
SERVING_SCHEMA = os.environ.get("SERVING_SCHEMA", "baseline_serving")
OPS_SCHEMA = os.environ.get("OPS_SCHEMA", "baseline_ops")
RAW_SCHEMA = os.environ.get("RAW_SCHEMA", "baseline_raw")
WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
CLOSE_PERIOD = os.environ.get("CLOSE_PERIOD", "2026-06")
# Frozen "today" for Month-End Close so demos don't drift with the wall clock.
# Unset / invalid → real date.today() (dev escape hatch).
DEMO_AS_OF = os.environ.get("DEMO_AS_OF", "2026-07-15").strip()
# The company the demo is installed for (asked once by scripts/setup.py). It names
# the app in the top bar, and competitor benchmarking asks the model for its peers.
# Collapsed to one line and capped, because it reaches an ai_query prompt.
COMPANY_NAME = " ".join(os.environ.get("CFO_COMPANY_NAME", "").split())[:120]

_PERIOD_RE = re.compile(r"^\d{4}-\d{2}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def resolve_period(period: str | None) -> str:
    """Validate a YYYY-MM period from a request; fall back to the active close.

    When X-Demo-Today is set, inbound periods are display-calendar values and are
    mapped back onto the seeded CLOSE_PERIOD timeline before SQL.
    """
    p = (period or "").strip()
    if not _PERIOD_RE.match(p):
        return CLOSE_PERIOD
    from .demo_calendar import month_offset, to_seed_period
    return to_seed_period(p) if month_offset() else p


def demo_today() -> date:
    """Close-workflow 'today'.

    With X-Demo-Today, this is the seed-equivalent of the browser date so existing
    overdue / close-day math stays on the seeded timeline. Without the header,
    DEMO_AS_OF freezes the clock (tests / scripts); unset/invalid → date.today().
    """
    from .demo_calendar import seed_today
    mapped = seed_today()
    if mapped is not None:
        return mapped
    raw = (DEMO_AS_OF or "").strip()
    if raw and _DATE_RE.match(raw):
        try:
            return date.fromisoformat(raw)
        except ValueError:
            pass
    return date.today()


def demo_close_today() -> date:
    """Frozen operational clock for seeded close-cycle charts.

    Task statuses were seeded at DEMO_AS_OF. Keeping that stage prevents a
    browser date before month-end from projecting a nearly completed close from
    T-2; response dates are still relabelled onto the display calendar.
    """
    raw = (DEMO_AS_OF or "").strip()
    if raw and _DATE_RE.match(raw):
        try:
            return date.fromisoformat(raw)
        except ValueError:
            pass
    return date.today()

# --- Multi-industry layout -------------------------------------------------
# When enabled (default), each industry gets its own schema set in a dedicated
# catalog: {MULTI_CATALOG}.{industry}_{raw,close,serving,ops}. Flip CFO_MULTI_INDUSTRY=0
# to run the untouched single-industry baseline ({CATALOG}.baseline_*).
MULTI_INDUSTRY = os.environ.get("CFO_MULTI_INDUSTRY", "1").strip().lower() not in ("0", "false", "no")

_industry_var: "contextvars.ContextVar[str]" = contextvars.ContextVar(
    "cfo_industry", default=DEFAULT_INDUSTRY)

_BASELINE_LAYER = {"raw": RAW_SCHEMA, "close": CLOSE_SCHEMA,
                   "serving": SERVING_SCHEMA, "ops": OPS_SCHEMA}


def set_current_industry(x_industry: str | None) -> str:
    """Resolve + store the active industry for this request context."""
    ind = resolve_industry(x_industry)
    _industry_var.set(ind)
    return ind


def current_industry() -> str:
    return _industry_var.get()


def schema_fq(layer: str, industry: str | None = None) -> str:
    """Fully-qualified schema for a layer (raw/close/serving/ops) in the active
    (or given) industry — or the single-industry baseline when MULTI_INDUSTRY off."""
    if MULTI_INDUSTRY:
        return f"{MULTI_CATALOG}.{(industry or current_industry())}_{layer}"
    return f"{CATALOG}.{_BASELINE_LAYER[layer]}"


class _SchemaProxy:
    """str-like handle that resolves to the active industry's schema each time it
    is interpolated into a query, so module-level route constants stay per-request."""
    __slots__ = ("layer",)

    def __init__(self, layer: str):
        self.layer = layer

    def __str__(self) -> str:
        return schema_fq(self.layer)

    def __format__(self, spec: str) -> str:
        return format(schema_fq(self.layer), spec)

    def __repr__(self) -> str:
        return schema_fq(self.layer)


# Proxies used by the route modules (aliased to their local SRV/OPS/CLOSE names).
SRV_FQ = _SchemaProxy("serving")
CLOSE_FQ = _SchemaProxy("close")
OPS_FQ = _SchemaProxy("ops")
RAW_FQ = _SchemaProxy("raw")


def raw_volume(name: str, industry: str | None = None) -> str:
    """UC Volume path under the active industry's raw schema (uploads/close-folder)."""
    if MULTI_INDUSTRY:
        return f"/Volumes/{MULTI_CATALOG}/{(industry or current_industry())}_raw/{name}"
    return f"/Volumes/{CATALOG}/{RAW_SCHEMA}/{name}"


# Unstructured close-support documents (IDP source PDFs + uploads). Shared across
# industries: it lives under the baseline raw schema and is not cloned.
CLOSE_DOCUMENTS_VOLUME = os.environ.get(
    "CLOSE_DOCUMENTS_VOLUME", f"/Volumes/{CATALOG}/{RAW_SCHEMA}/close_documents")

# Genie space for the CFO self-service chat (Act 5). Per-industry override map
# (env GENIE_SPACE_ID_<INDUSTRY>) falls back to the shared default space when an
# industry has no dedicated space yet.
GENIE_SPACE_ID = os.environ.get("GENIE_SPACE_ID", "")


def genie_space_id(industry: str | None = None) -> str:
    ind = (industry or current_industry()).upper()
    return os.environ.get(f"GENIE_SPACE_ID_{ind}", GENIE_SPACE_ID)


# Dedicated Genie space for reconciliation break INVESTIGATION (root-cause
# analysis over the source_ref-linked, economically-enriched subledger/GL data).
# Distinct from the self-service chat space above. Per-industry override
# (GENIE_INVESTIGATION_SPACE_ID_<INDUSTRY>), then the shared id, then the
# industry's self-service space.
GENIE_INVESTIGATION_SPACE_ID = os.environ.get("GENIE_INVESTIGATION_SPACE_ID", "")


def genie_investigation_space_id(industry: str | None = None) -> str:
    """Space id for the reconciliation break-investigation Genie space."""
    ind = (industry or current_industry()).upper()
    return (os.environ.get(f"GENIE_INVESTIGATION_SPACE_ID_{ind}")
            or GENIE_INVESTIGATION_SPACE_ID or genie_space_id(industry))
# Optional explicit iframe embed URL. If unset, it is derived from the workspace
# host + space id. Paste the exact URL from the Genie Share > Embed dialog here
# (env GENIE_EMBED_URL) if the derived one differs for your workspace.
GENIE_EMBED_URL = os.environ.get("GENIE_EMBED_URL")

# Optional AI ROI integrations. Core AI ROI reads always use the active
# industry's SRV_FQ; these values only enrich responses when the corresponding
# native asset or pre-aggregated gateway table has been configured.
AI_ROI_GATEWAY_TABLE = os.environ.get("AI_ROI_GATEWAY_TABLE")
if AI_ROI_GATEWAY_TABLE is None and MULTI_INDUSTRY:
    AI_ROI_GATEWAY_TABLE = f"{MULTI_CATALOG}.app_ops.ai_gateway_usage_daily"
AI_ROI_DASHBOARD_URL = os.environ.get("AI_ROI_DASHBOARD_URL")
AI_ROI_GENIE_URL = os.environ.get("AI_ROI_GENIE_URL")
AI_ROI_METRIC_VIEW_URL = os.environ.get("AI_ROI_METRIC_VIEW_URL")


# Lakebase (Autoscaling) defaults, shared by every industry unless overridden per
# industry in server/lakebase.py. LAKEBASE_PROJECT alone is enough: the endpoint
# follows the project's default production branch, and an empty PGHOST is
# resolved from that endpoint at first connection.
LAKEBASE_PROJECT = os.environ.get("LAKEBASE_PROJECT", "")
LAKEBASE_ENDPOINT = os.environ.get("ENDPOINT_NAME") or (
    f"projects/{LAKEBASE_PROJECT}/branches/production/endpoints/primary" if LAKEBASE_PROJECT else "")
PGHOST = os.environ.get("PGHOST", "")
PGDATABASE = os.environ.get("PGDATABASE", "databricks_postgres")
PGPORT = os.environ.get("PGPORT", "5432")

_client: WorkspaceClient | None = None

# On-behalf-of-user (OBO): Databricks Apps forwards the signed-in user's
# downscoped OAuth token in the ``X-Forwarded-Access-Token`` header. We stash it
# in a ContextVar (set by middleware in app.py) so ``get_workspace_client()`` can
# act *as that user* for the request — reads then use the viewer's Unity Catalog
# grants instead of the app service principal's. Falls back to the SP client when
# no user token is present (local dev, health checks, background work). This lets
# the app work for a viewer who has catalog access even when the app SP is not
# granted on the catalog.
_user_token_var: "contextvars.ContextVar[str | None]" = contextvars.ContextVar(
    "cfo_user_token", default=None)
# Per-token WorkspaceClient cache so we don't rebuild the client every request
# for the same (short-lived, rotating) token.
_user_clients: "dict[str, WorkspaceClient]" = {}


def set_user_token(token: str | None) -> None:
    """Store the forwarded user OAuth token for this request context."""
    _user_token_var.set(token or None)


def _workspace_host() -> str:
    """Workspace host URL with scheme (DATABRICKS_HOST is scheme-less in Apps)."""
    host = os.environ.get("DATABRICKS_HOST", "")
    if host and not host.startswith("http"):
        host = f"https://{host}"
    return host


def _sp_client() -> WorkspaceClient:
    global _client
    if _client is None:
        if IS_DATABRICKS_APP:
            _client = WorkspaceClient()
        else:
            profile = os.environ.get("DATABRICKS_CONFIG_PROFILE") or os.environ.get("DATABRICKS_PROFILE")
            _client = WorkspaceClient(profile=profile) if profile else WorkspaceClient()
    return _client


def get_workspace_client() -> WorkspaceClient:
    """Return the app data-plane client.

    Warehouse and Lakebase access always run as the app service principal so
    viewers do not need their own SQL, catalog, or database grants.
    """
    return _sp_client()


def get_user_workspace_client() -> WorkspaceClient:
    """Return an OBO client when available, otherwise the app data-plane client.

    Use this only for APIs that intentionally act as the signed-in viewer.
    """
    token = _user_token_var.get()
    if token:
        cached = _user_clients.get(token)
        if cached is None:
            # Force PAT-only auth: the app SP's ambient DATABRICKS_CLIENT_ID/SECRET
            # env vars would otherwise collide with this token ("more than one
            # authorization method configured: oauth and pat"). auth_type="pat"
            # pins the SDK to the forwarded user token alone.
            cached = WorkspaceClient(
                host=_workspace_host(), token=token, auth_type="pat")
            _user_clients[token] = cached
        return cached
    return _sp_client()


def genie_embed_url() -> str:
    """URL for the embedded Genie space iframe. Uses GENIE_EMBED_URL if set,
    otherwise derives it from the workspace host and space id."""
    if GENIE_EMBED_URL:
        return GENIE_EMBED_URL
    host = (get_workspace_client().config.host or "").rstrip("/")
    # The embeddable "Data Room" build lives at /embed/genie/rooms/{id} and serves
    # `frame-ancestors *` so it can be iframed. (/embed/genie/{id} is a 404, and
    # /genie/rooms/{id} is the full app with a restrictive frame-ancestors allowlist.)
    return f"{host}/embed/genie/rooms/{genie_space_id()}"


def current_user() -> str:
    if IS_DATABRICKS_APP:
        return os.environ.get("DATABRICKS_APP_NAME", "office-of-cfo") + " (app)"
    try:
        return get_workspace_client().current_user.me().user_name or "unknown"
    except Exception:
        return "unknown"


def pg_user() -> str:
    user = os.environ.get("PGUSER")
    if user:
        return user
    # Databricks Apps injects the app service-principal client id. Lakebase
    # federated roles are named after that id, so each app (prod vs preview)
    # connects as itself without a hardcoded PGUSER in app.yaml.
    client_id = os.environ.get("DATABRICKS_CLIENT_ID")
    if client_id:
        return client_id
    # Local dev: connect to Lakebase as the signed-in user.
    return get_workspace_client().current_user.me().user_name

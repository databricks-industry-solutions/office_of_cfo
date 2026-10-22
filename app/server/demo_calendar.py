"""Per-request demo calendar: map display periods/dates onto the seeded timeline."""
from __future__ import annotations

import calendar
import contextvars
import re
from datetime import date

_PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_DATE_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])-(\d{2})$")

_browser_today: contextvars.ContextVar[date | None] = contextvars.ContextVar(
    "demo_browser_today", default=None)


def set_browser_today(raw: str | None) -> None:
    """Store a validated YYYY-MM-DD from X-Demo-Today, or clear on invalid/missing."""
    s = (raw or "").strip()
    if s and _DATE_RE.match(s):
        try:
            _browser_today.set(date.fromisoformat(s))
            return
        except ValueError:
            pass
    _browser_today.set(None)


def browser_today() -> date | None:
    return _browser_today.get()


def _seed_close() -> str:
    from .config import CLOSE_PERIOD
    return CLOSE_PERIOD


def months_between(a: str, b: str) -> int:
    if not (_PERIOD_RE.match(a) and _PERIOD_RE.match(b)):
        return 0
    ay, am = int(a[:4]), int(a[5:7])
    by, bm = int(b[:4]), int(b[5:7])
    return (by * 12 + bm) - (ay * 12 + am)


def shift_period(period: str, months: int) -> str:
    if not _PERIOD_RE.match(period):
        return period
    y, m = int(period[:4]), int(period[5:7])
    total = y * 12 + (m - 1) + months
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def shift_date(d: date, months: int) -> date:
    src_last = calendar.monthrange(d.year, d.month)[1]
    total = d.year * 12 + (d.month - 1) + months
    y, m = total // 12, total % 12 + 1
    last = calendar.monthrange(y, m)[1]
    day = last if d.day == src_last else min(d.day, last)
    return date(y, m, day)


def month_offset() -> int:
    today = browser_today()
    if today is None:
        return 0
    return months_between(_seed_close(), f"{today.year:04d}-{today.month:02d}")


def to_display_period(seed: str) -> str:
    return shift_period(seed, month_offset())


def to_seed_period(display: str) -> str:
    p = shift_period(display, -month_offset())
    return p if _PERIOD_RE.match(p) else _seed_close()


def seed_today() -> date | None:
    """Seed-equivalent of the browser date, or None if the header was absent."""
    today = browser_today()
    if today is None:
        return None
    return shift_date(today, -month_offset())


def quarter_months(period: str) -> list[str]:
    """Calendar quarter-to-date through `period` (not the full quarter).

    June (end of Q2) still yields Apr–Jun; August (mid Q3) yields Jul–Aug so we
    do not invent a September month that has no seed equivalent.
    """
    y, m = int(period[:4]), int(period[5:7])
    start = ((m - 1) // 3) * 3 + 1
    return [f"{y:04d}-{mm:02d}" for mm in range(start, m + 1)]


def ytd_months(period: str) -> list[str]:
    y, m = int(period[:4]), int(period[5:7])
    return [f"{y:04d}-{mm:02d}" for mm in range(1, m + 1)]


def display_window_months(window: str, display_period: str) -> list[str]:
    if window == "ytd":
        return ytd_months(display_period)
    if window == "qtd":
        return quarter_months(display_period)
    return [display_period]


def seed_months(display_months: list[str]) -> list[str]:
    return [to_seed_period(m) for m in display_months]

"""What this deployment was installed with: the company and the industries.

scripts/setup.py asks for the company once and passes it to the app as
CFO_COMPANY_NAME (bundle variable `company_name`), and the industries as
CFO_INDUSTRIES (`--industries`, bundle variable `industries`). The top bar shows
the company, competitor benchmarking derives that company's peers from it, and
the industry switcher lists only the installed industries. There is no in-app
picker: re-run setup to change either.
"""
from __future__ import annotations

from fastapi import APIRouter

from ..config import COMPANY_NAME
from ..industry import INSTALLED_INDUSTRIES

router = APIRouter()


@router.get("/deployment")
def deployment():
    return {"company": COMPANY_NAME, "industries": list(INSTALLED_INDUSTRIES)}

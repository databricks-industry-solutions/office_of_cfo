"""The repo names no company to benchmark against.

The only real company in a deployment is the one named at install (--company),
and competitor benchmarking asks the model for its peers at run time. This test
fails if a curated peer list, quick-pick list or the old logo picker comes back.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCANNED = ("app/server", "app/frontend/src", "config", "resources", "scripts", "databricks.yml")
FORBIDDEN = re.compile(r"QUICK_PICKS|quick-picks|competitorSuggestions|competitor_peers|"
                       r"[Bb]rand[Ff]etch|BRANDFETCH")


def _files():
    for rel in SCANNED:
        path = ROOT / rel
        for f in [path] if path.is_file() else path.rglob("*"):
            if f.is_file() and f.suffix in {".py", ".ts", ".tsx", ".yml", ".yaml"} \
                    and "node_modules" not in f.parts and "__pycache__" not in f.parts:
                yield f


def test_no_curated_company_lists():
    hits = [f"{f.relative_to(ROOT)}:{n}: {line.strip()}"
            for f in _files()
            for n, line in enumerate(f.read_text(errors="ignore").splitlines(), 1)
            if FORBIDDEN.search(line)]
    assert not hits, "Curated company lists are back; derive peers from the configured company:\n" \
        + "\n".join(hits)


def test_company_reaches_the_app():
    import yaml
    env = (ROOT / "resources" / "app.app.yml").read_text()
    assert re.search(r'name: CFO_COMPANY_NAME\s+value: "\$\{var\.company_name\}"', env)
    var = yaml.safe_load((ROOT / "databricks.yml").read_text())["variables"]["company_name"]
    # No default on purpose: setup asks for the company instead of assuming one.
    assert "default" not in var

"""DEMO_AS_OF freezes close-workflow 'today' so demos don't drift."""
from __future__ import annotations

import pathlib
import sys
from datetime import date
from unittest import mock

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import config  # noqa: E402


def test_demo_today_uses_env_when_valid():
    with mock.patch.object(config, "DEMO_AS_OF", "2026-07-15"):
        assert config.demo_today() == date(2026, 7, 15)


def test_demo_today_falls_back_on_invalid():
    with mock.patch.object(config, "DEMO_AS_OF", "not-a-date"):
        with mock.patch("server.config.date") as mock_date:
            mock_date.today.return_value = date(2026, 8, 18)
            mock_date.fromisoformat = date.fromisoformat
            assert config.demo_today() == date(2026, 8, 18)


def test_demo_today_falls_back_when_empty():
    with mock.patch.object(config, "DEMO_AS_OF", ""):
        with mock.patch("server.config.date") as mock_date:
            mock_date.today.return_value = date(2026, 8, 18)
            mock_date.fromisoformat = date.fromisoformat
            assert config.demo_today() == date(2026, 8, 18)


if __name__ == "__main__":
    test_demo_today_uses_env_when_valid()
    test_demo_today_falls_back_on_invalid()
    test_demo_today_falls_back_when_empty()
    print("ok")

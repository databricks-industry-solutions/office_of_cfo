"""Genie uses OBO when possible and the app identity when OBO lacks scope."""
from __future__ import annotations

import pathlib
import sys
from types import SimpleNamespace
from unittest import mock

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.routes import genie  # noqa: E402


class _PermissionDenied(Exception):
    pass


def test_genie_retries_with_app_client_when_obo_lacks_scope():
    user_api = mock.MagicMock()
    app_api = mock.MagicMock()
    expected = object()
    user_api.start_conversation_and_wait.side_effect = _PermissionDenied("missing scope")
    app_api.start_conversation_and_wait.return_value = expected

    with mock.patch.object(genie, "PermissionDenied", _PermissionDenied, create=True), \
         mock.patch.object(
             genie, "get_user_workspace_client",
             return_value=SimpleNamespace(genie=user_api), create=True,
         ), \
         mock.patch.object(
             genie, "get_workspace_client",
             return_value=SimpleNamespace(genie=app_api),
         ):
        result = genie._call_genie("start_conversation_and_wait", "space", "question")

    assert result is expected
    user_api.start_conversation_and_wait.assert_called_once_with("space", "question")
    app_api.start_conversation_and_wait.assert_called_once_with("space", "question")


def test_genie_does_not_mask_non_permission_errors():
    user_api = mock.MagicMock()
    app_api = mock.MagicMock()
    user_api.create_message_and_wait.side_effect = RuntimeError("service unavailable")

    with mock.patch.object(genie, "PermissionDenied", _PermissionDenied, create=True), \
         mock.patch.object(
             genie, "get_user_workspace_client",
             return_value=SimpleNamespace(genie=user_api), create=True,
         ), \
         mock.patch.object(
             genie, "get_workspace_client",
             return_value=SimpleNamespace(genie=app_api),
         ):
        try:
            genie._call_genie("create_message_and_wait", "space", "conversation", "question")
        except RuntimeError as exc:
            assert str(exc) == "service unavailable"
        else:
            raise AssertionError("RuntimeError was not raised")

    app_api.create_message_and_wait.assert_not_called()


"""Identity routing tests for Databricks workspace clients."""
from __future__ import annotations

import pathlib
import sys
from unittest import mock

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import config  # noqa: E402


def _reset_clients() -> None:
    config._client = None
    config._user_clients.clear()
    config.set_user_token(None)


def test_data_client_ignores_forwarded_user_token():
    sp_client = object()
    with mock.patch.object(config, "IS_DATABRICKS_APP", True), \
         mock.patch.object(config, "WorkspaceClient", return_value=sp_client) as client:
        _reset_clients()
        config.set_user_token("forwarded-token")

        assert config.get_workspace_client() is sp_client
        client.assert_called_once_with()


def test_user_client_uses_forwarded_token_when_present():
    sp_client = object()
    user_client = object()

    def build_client(**kwargs):
        return user_client if kwargs.get("token") else sp_client

    with mock.patch.object(config, "IS_DATABRICKS_APP", True), \
         mock.patch.object(config, "WorkspaceClient", side_effect=build_client):
        _reset_clients()
        config.set_user_token("forwarded-token")

        assert config.get_user_workspace_client() is user_client
        assert config.get_workspace_client() is sp_client


def test_user_client_falls_back_to_data_client_without_token():
    sp_client = object()
    with mock.patch.object(config, "IS_DATABRICKS_APP", True), \
         mock.patch.object(config, "WorkspaceClient", return_value=sp_client) as client:
        _reset_clients()

        assert config.get_user_workspace_client() is sp_client
        client.assert_called_once_with()


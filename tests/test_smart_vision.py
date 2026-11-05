"""Tests for the Smart Vision live feed credentials."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.setup import async_setup_component
from yarbo_robot_sdk import YarboSDKError

from custom_components.yarbo.const import DOMAIN
from custom_components.yarbo.coordinator import YarboDataUpdateCoordinator
from custom_components.yarbo.smart_vision import (
    TOKEN_URL,
    SmartVisionError,
    SmartVisionTokenExpired,
    async_fetch_credentials,
    parse_credentials,
)
from custom_components.yarbo.websocket_api import async_register

SN = "SN123"
GOOD_DATA = {
    "appId": "app",
    "token": "agora-secret",
    "channel_name": "chan",
    "uid": 7,
    "encryptKey": "key-secret",
    "encryptSalt": "c2FsdA==",
    "expireAt": 1800000000,
}


def _ok(data=None) -> dict:
    return {"code": "00000", "data": GOOD_DATA if data is None else data, "success": True}


def test_parse_reads_all_fields() -> None:
    assert parse_credentials(_ok()) == {
        "app_id": "app",
        "token": "agora-secret",
        "channel": "chan",
        "uid": 7,
        "encrypt_key": "key-secret",
        "encrypt_salt": "c2FsdA==",
        "expire_at": 1800000000,
    }


def test_parse_keeps_a_zero_uid() -> None:
    assert parse_credentials(_ok({**GOOD_DATA, "uid": 0}))["uid"] == 0


def test_parse_allows_missing_encryption() -> None:
    data = {"appId": "app", "token": "t", "channel_name": "chan"}
    credentials = parse_credentials(_ok(data))
    assert credentials["encrypt_key"] is None
    assert credentials["encrypt_salt"] is None


def test_parse_missing_fields_names_keys_but_never_values() -> None:
    with pytest.raises(SmartVisionError) as err:
        parse_credentials(_ok({"token": "agora-secret", "mystery": "other-secret"}))
    message = str(err.value)
    assert "app_id" in message and "channel" in message
    assert "mystery" in message and "token" in message
    assert "secret" not in message


def test_parse_string_data_does_not_leak_it() -> None:
    with pytest.raises(SmartVisionError) as err:
        parse_credentials(_ok("agora-secret"))
    assert "secret" not in str(err.value)


def test_parse_expired_token() -> None:
    body = {"code": "A0230", "data": {}, "message": "token invalid or expired.", "success": False}
    with pytest.raises(SmartVisionTokenExpired):
        parse_credentials(body)


def test_parse_refusal_passes_on_the_message() -> None:
    body = {"code": "A0400", "data": {}, "message": "no access", "success": False}
    with pytest.raises(SmartVisionError, match="no access") as err:
        parse_credentials(body)
    assert not isinstance(err.value, SmartVisionTokenExpired)


@pytest.mark.parametrize("body", [None, [], "text"])
def test_parse_rejects_non_object_bodies(body) -> None:
    with pytest.raises(SmartVisionError):
        parse_credentials(body)


async def test_fetch_sends_bearer_token(hass, aioclient_mock) -> None:
    aioclient_mock.post(TOKEN_URL, json=_ok())
    credentials = await async_fetch_credentials(hass, "session-jwt", SN)
    assert credentials["token"] == "agora-secret"
    _, _, body, headers = aioclient_mock.mock_calls[0]
    assert headers["Authorization"] == "Bearer session-jwt"
    assert body["sn"] == SN


async def test_fetch_http_401_is_token_expired(hass, aioclient_mock) -> None:
    aioclient_mock.post(TOKEN_URL, status=401)
    with pytest.raises(SmartVisionTokenExpired):
        await async_fetch_credentials(hass, "session-jwt", SN)


async def test_fetch_http_error(hass, aioclient_mock) -> None:
    aioclient_mock.post(TOKEN_URL, status=500)
    with pytest.raises(SmartVisionError, match="500"):
        await async_fetch_credentials(hass, "session-jwt", SN)


async def test_fetch_non_json_response(hass, aioclient_mock) -> None:
    aioclient_mock.post(TOKEN_URL, text="<html>")
    with pytest.raises(SmartVisionError):
        await async_fetch_credentials(hass, "session-jwt", SN)


def _coordinator(hass) -> YarboDataUpdateCoordinator:
    coordinator = YarboDataUpdateCoordinator.__new__(YarboDataUpdateCoordinator)
    coordinator.hass = hass
    coordinator._client = MagicMock(token="old-jwt")
    coordinator._update_stored_tokens = MagicMock()
    return coordinator


async def test_coordinator_refreshes_once_then_succeeds(hass) -> None:
    coordinator = _coordinator(hass)

    def refresh():
        coordinator._client.token = "new-jwt"

    coordinator._client.get_devices.side_effect = refresh
    fetch = AsyncMock(side_effect=[SmartVisionTokenExpired("expired"), {"token": "t"}])
    with patch("custom_components.yarbo.coordinator.async_fetch_credentials", fetch):
        credentials = await coordinator.async_get_smart_vision_credentials(SN)

    assert credentials == {"token": "t"}
    assert [call.args[1] for call in fetch.call_args_list] == ["old-jwt", "new-jwt"]
    coordinator._client.get_devices.assert_called_once()
    coordinator._update_stored_tokens.assert_called_once()


async def test_coordinator_reports_a_login_the_service_rejects(hass, aioclient_mock) -> None:
    coordinator = _coordinator(hass)
    aioclient_mock.post(
        TOKEN_URL, json={"code": "A0230", "data": {}, "message": "expired", "success": False}
    )
    with pytest.raises(SmartVisionError, match="rejected this integration's login") as err:
        await coordinator.async_get_smart_vision_credentials(SN)
    assert not isinstance(err.value, SmartVisionTokenExpired)
    assert aioclient_mock.call_count == 2


async def test_coordinator_failed_session_renewal(hass, aioclient_mock) -> None:
    coordinator = _coordinator(hass)
    coordinator._client.get_devices.side_effect = YarboSDKError("refresh failed")
    aioclient_mock.post(TOKEN_URL, status=401)
    with pytest.raises(SmartVisionError, match="Could not renew"):
        await coordinator.async_get_smart_vision_credentials(SN)


@pytest.fixture
async def ws_coordinator(hass):
    assert await async_setup_component(hass, "websocket_api", {})
    async_register(hass)
    coordinator = SimpleNamespace(
        devices=[SimpleNamespace(sn=SN)],
        async_get_smart_vision_credentials=AsyncMock(return_value={"token": "t"}),
    )
    hass.data.setdefault(DOMAIN, {})["entry"] = coordinator
    return coordinator


async def test_ws_returns_credentials(hass, hass_ws_client, ws_coordinator) -> None:
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/smart_vision/credentials", "sn": SN})
    response = await client.receive_json()
    assert response["success"] is True
    assert response["result"] == {"token": "t"}


async def test_ws_unknown_serial(hass, hass_ws_client, ws_coordinator) -> None:
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/smart_vision/credentials", "sn": "other"})
    response = await client.receive_json()
    assert response["success"] is False
    assert response["error"]["code"] == "not_found"
    ws_coordinator.async_get_smart_vision_credentials.assert_not_called()


async def test_ws_passes_on_errors(hass, hass_ws_client, ws_coordinator) -> None:
    ws_coordinator.async_get_smart_vision_credentials.side_effect = SmartVisionError("nope")
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/smart_vision/credentials", "sn": SN})
    response = await client.receive_json()
    assert response["error"] == {"code": "smart_vision_unavailable", "message": "nope"}


async def test_ws_requires_admin(hass, hass_ws_client, hass_admin_user, ws_coordinator) -> None:
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/smart_vision/credentials", "sn": SN})
    response = await client.receive_json()
    assert response["success"] is False
    assert response["error"]["code"] == "unauthorized"
    ws_coordinator.async_get_smart_vision_credentials.assert_not_called()


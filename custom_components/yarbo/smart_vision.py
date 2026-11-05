"""Smart Vision live feed: the Agora credentials a dashboard card needs to join.

The Yarbo app streams the robot's cameras through Agora rather than a local video
stream, so there is no RTSP or HLS source to hand to a ``camera`` entity. The
browser joins the channel directly (see ``www/yarbo-smart-vision-card.js``) and
this module only fetches what it needs, from the same backend route the app uses
and on the owner's own session.

Confirmed against the live backend: the URL, POST, and the response envelope.
Not yet confirmed: the request body, and whether this route accepts the session
the SDK logs in with. The field names are read from the app and may be incomplete.
Errors name the fields a response did contain (never their values), so the first
real response shows what needs correcting here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aiohttp import ClientError, ClientTimeout
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

TOKEN_URL = (
    "https://4zx17x5q7l.execute-api.us-east-1.amazonaws.com"
    "/Stage/yarbo/robot-service/robot/commonUser/getAgoraToken"
)
TOKEN_EXPIRED_CODE = "A0230"
REQUEST_TIMEOUT = ClientTimeout(total=15)

# Response field -> names it may arrive under. These come from strings in the app;
# which ones this route really returns is still to be confirmed.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "app_id": ("appId", "appID", "app_id"),
    "token": ("token", "agoraToken", "rtcToken"),
    "channel": ("channel_name", "channelName", "channel"),
    "uid": ("uid", "localUid", "userId"),
    "encrypt_key": ("encryptKey", "encryptionKey"),
    "encrypt_salt": ("encryptSalt", "salt"),
    "expire_at": ("expireAt",),
}
REQUIRED_FIELDS = ("app_id", "token", "channel")

CARD_FILE = Path(__file__).parent / "www" / "yarbo-smart-vision-card.js"
CARD_URL = "/yarbo_static/yarbo-smart-vision-card.js"
CARD_VERSION = "1"
_CARD_REGISTERED_KEY = "yarbo_smart_vision_card_registered"


class SmartVisionError(Exception):
    """The live feed credentials could not be fetched."""


class SmartVisionTokenExpired(SmartVisionError):
    """The backend rejected the session token."""


def parse_credentials(body: Any) -> dict[str, Any]:
    """Pull the Agora credentials out of a response body.

    Raises SmartVisionError naming what is missing. Only field names are ever
    included in the message, since the values are secrets.
    """
    if not isinstance(body, dict):
        raise SmartVisionError("The Yarbo video service sent an unexpected response.")

    if str(body.get("code")) == TOKEN_EXPIRED_CODE:
        raise SmartVisionTokenExpired(body.get("message") or "Session token rejected.")
    if body.get("success") is False:
        raise SmartVisionError(
            f"The Yarbo video service refused the request: {body.get('message')}"
        )

    data = body.get("data", body)
    if not isinstance(data, dict):
        raise SmartVisionError(
            "The Yarbo video service sent an unexpected response: "
            f"data is a {type(data).__name__}, not an object."
        )

    credentials = {
        field: next((data[name] for name in names if data.get(name) not in (None, "")), None)
        for field, names in FIELD_ALIASES.items()
    }
    missing = [field for field in REQUIRED_FIELDS if credentials[field] is None]
    if missing:
        raise SmartVisionError(
            f"The Yarbo video service response is missing {', '.join(missing)}. "
            f"It contained these fields: {', '.join(sorted(data)) or 'none'}."
        )
    return credentials


async def async_fetch_credentials(
    hass: HomeAssistant, session_token: str, sn: str
) -> dict[str, Any]:
    """Request Agora credentials for a device on the owner's session."""
    try:
        resp = await async_get_clientsession(hass).post(
            TOKEN_URL,
            json={"sn": sn, "channel_name": sn},
            headers={"Authorization": f"Bearer {session_token}"},
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status == 401:
            raise SmartVisionTokenExpired("Session token rejected.")
        if resp.status >= 400:
            raise SmartVisionError(f"The Yarbo video service returned HTTP {resp.status}.")
        body = await resp.json(content_type=None)
    except (ClientError, TimeoutError, ValueError) as err:
        raise SmartVisionError(f"Could not reach the Yarbo video service: {err}") from err
    return parse_credentials(body)


async def async_register_card(hass: HomeAssistant) -> None:
    """Serve the dashboard card and load it in the frontend, once per instance."""
    if hass.data.get(_CARD_REGISTERED_KEY):
        return
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(CARD_FILE), cache_headers=False)]
    )
    add_extra_js_url(hass, f"{CARD_URL}?v={CARD_VERSION}")
    hass.data[_CARD_REGISTERED_KEY] = True

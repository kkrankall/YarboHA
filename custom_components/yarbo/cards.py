"""Serve the integration's dashboard cards and load them in the frontend.

Each card is loaded with a fingerprint of its contents in the URL, so browsers
pick up a new version after an update without a manual cache clear.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

WWW_DIR = Path(__file__).parent / "www"
STATIC_URL = "/yarbo_static"
CARD_FILES = ("yarbo-smart-vision-card.js", "yarbo-card.js")
_REGISTERED_KEY = "yarbo_cards_registered"


def _fingerprints() -> dict[str, str]:
    return {
        name: hashlib.sha256((WWW_DIR / name).read_bytes()).hexdigest()[:12]
        for name in CARD_FILES
    }


async def async_register_cards(hass: HomeAssistant) -> None:
    """Serve the card files and load them in the frontend, once per instance."""
    if hass.data.get(_REGISTERED_KEY):
        return
    # Claimed before the first await so a second config entry setting up at the
    # same time doesn't register the static path twice.
    hass.data[_REGISTERED_KEY] = True
    try:
        fingerprints = await hass.async_add_executor_job(_fingerprints)
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(WWW_DIR), cache_headers=False)]
        )
    except Exception:
        hass.data.pop(_REGISTERED_KEY, None)
        raise
    for name in CARD_FILES:
        add_extra_js_url(hass, f"{STATIC_URL}/{name}?v={fingerprints[name]}")

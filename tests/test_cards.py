"""Tests for the dashboard cards and the device lookup they rely on."""

from __future__ import annotations

import re
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.yarbo.cards import (
    CARD_FILES,
    PICTURES_DIR,
    STATIC_URL,
    WWW_DIR,
    _fingerprints,
    async_register_cards,
)
from custom_components.yarbo.const import DOMAIN
from custom_components.yarbo.websocket_api import async_register

SN = "SN123"


def test_card_files_exist() -> None:
    for name in CARD_FILES:
        assert (WWW_DIR / name).is_file()


def test_card_pictures_match_the_card() -> None:
    """Every picture the Yarbo card names exists, at the width the card reserves for it."""
    image = pytest.importorskip("PIL.Image")
    source = (WWW_DIR / "yarbo-card.js").read_text()
    table = re.search(r"const PICTURES = \{(.*?)\};", source, re.S).group(1)
    widths = {name: int(width) for name, width in re.findall(r'"([a-z]-[a-z]+)": (\d+)', table)}
    lit = re.search(r"const LIT_PICTURES = new Set\(\[(.*?)\]\)", source).group(1)
    lit_names = re.findall(r'"([^"]+)"', lit)
    assert widths and lit_names and set(lit_names) <= set(widths)

    files = dict(widths) | {f"{name}-lights": widths[name] for name in lit_names}
    for name, width in files.items():
        with image.open(PICTURES_DIR / f"{name}.webp") as picture:
            assert picture.size == (width, 600), name
    assert {path.stem for path in PICTURES_DIR.glob("*.webp")} == set(files)


def test_pictures_change_the_card_fingerprint(tmp_path) -> None:
    www = tmp_path / "www"
    (www / "images").mkdir(parents=True)
    for name in CARD_FILES:
        (www / name).write_text("card")
    (www / "images" / "y-core.webp").write_bytes(b"one")
    with (
        patch("custom_components.yarbo.cards.WWW_DIR", www),
        patch("custom_components.yarbo.cards.PICTURES_DIR", www / "images"),
    ):
        before = _fingerprints()
        (www / "images" / "y-core.webp").write_bytes(b"two")
        after = _fingerprints()
    assert before["yarbo-card.js"] != after["yarbo-card.js"]
    assert before["yarbo-smart-vision-card.js"] == after["yarbo-smart-vision-card.js"]


async def test_cards_are_registered_once(hass) -> None:
    hass.http = MagicMock(async_register_static_paths=AsyncMock())
    with patch("custom_components.yarbo.cards.add_extra_js_url") as add_js:
        await async_register_cards(hass)
        await async_register_cards(hass)

    hass.http.async_register_static_paths.assert_awaited_once()
    (config,) = hass.http.async_register_static_paths.call_args.args[0]
    assert config.url_path == STATIC_URL
    assert config.path == str(WWW_DIR)

    urls = [call.args[1] for call in add_js.call_args_list]
    assert len(urls) == len(CARD_FILES)
    for name, url in zip(CARD_FILES, urls):
        assert re.fullmatch(rf"{STATIC_URL}/{re.escape(name)}\?v=[0-9a-f]{{12}}", url)


async def test_failed_registration_can_be_retried(hass) -> None:
    hass.http = MagicMock(async_register_static_paths=AsyncMock(side_effect=[OSError, None]))
    with patch("custom_components.yarbo.cards.add_extra_js_url") as add_js:
        with pytest.raises(OSError):
            await async_register_cards(hass)
        await async_register_cards(hass)
    assert hass.http.async_register_static_paths.await_count == 2
    assert add_js.call_count == len(CARD_FILES)


@pytest.fixture
async def yarbo_device(hass):
    """A Yarbo device in the registries, with a renamed and a disabled entity."""
    assert await async_setup_component(hass, "websocket_api", {})
    async_register(hass)
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = SimpleNamespace(
        devices=[SimpleNamespace(sn=SN)]
    )

    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, SN)},
        name="Yarbo SN123",
        model="Yarbo Y",
    )
    dev_reg.async_update_device(device.id, name_by_user="Yard Master")

    ent_reg = er.async_get(hass)

    def add(domain, unique_id, object_id, **kwargs):
        return ent_reg.async_get_or_create(
            domain,
            kwargs.pop("platform", DOMAIN),
            unique_id,
            config_entry=entry,
            device_id=device.id,
            suggested_object_id=object_id,
            **kwargs,
        )

    add("sensor", f"{SN}_batterymsg_capacity", "yard_battery")
    add("button", f"{SN}_start_plan", "yard_start")
    add("switch", f"{SN}_ledinfomsg_led_head_switch", "yard_lights")
    add(
        "sensor",
        f"{SN}_combinedodom_x",
        "yard_x",
        disabled_by=er.RegistryEntryDisabler.INTEGRATION,
    )
    add("sensor", "unrelated", "other_platform", platform="other")
    renamed = ent_reg.async_get("sensor.yard_battery")
    ent_reg.async_update_entity(renamed.entity_id, new_entity_id="sensor.my_battery")
    return device


async def test_devices_lists_entities_by_key(hass, hass_ws_client, yarbo_device) -> None:
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/devices"})
    response = await client.receive_json()

    assert response["success"] is True
    assert response["result"] == {
        "devices": [
            {
                "device_id": yarbo_device.id,
                "sn": SN,
                "name": "Yard Master",
                "model": "Yarbo Y",
                "entities": {
                    "sensor.batterymsg_capacity": "sensor.my_battery",
                    "button.start_plan": "button.yard_start",
                    "switch.ledinfomsg_led_head_switch": "switch.yard_lights",
                },
            }
        ]
    }


async def test_devices_is_open_to_non_admins(
    hass, hass_ws_client, hass_admin_user, yarbo_device
) -> None:
    hass_admin_user.groups = []
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/devices"})
    response = await client.receive_json()
    assert response["success"] is True
    assert len(response["result"]["devices"]) == 1


async def test_devices_skips_robots_missing_from_registry(hass, hass_ws_client) -> None:
    assert await async_setup_component(hass, "websocket_api", {})
    async_register(hass)
    hass.data.setdefault(DOMAIN, {})["entry"] = SimpleNamespace(
        devices=[SimpleNamespace(sn="not-registered")]
    )
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "yarbo/devices"})
    response = await client.receive_json()
    assert response["result"] == {"devices": []}

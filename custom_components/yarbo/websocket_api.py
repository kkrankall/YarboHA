"""WebSocket API for Yarbo dashboard cards.

``yarbo/devices`` tells a card which entities belong to each robot,
``yarbo/smart_vision/credentials`` fetches what the live feed needs, and
``yarbo/map_zones`` returns the work-zone map on demand.

The full GeoJSON work-zone map is intentionally kept out of the ``map_zones``
sensor's state attributes: a complex map can exceed Home Assistant's 16 KB
attribute limit, which makes the recorder skip storage (logging a repeated
warning) and pushes the whole payload over WebSocket to every dashboard on each
state write. The frontend instead fetches the map on demand through the
``yarbo/map_zones`` command, which returns the GeoJSON straight from the
coordinator's in-memory cache only when a card actually needs it.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN
from .smart_vision import SmartVisionError

WS_TYPE_DEVICES = "yarbo/devices"
WS_TYPE_MAP_ZONES = "yarbo/map_zones"
WS_TYPE_SMART_VISION = "yarbo/smart_vision/credentials"
_REGISTERED_KEY = "yarbo_ws_registered"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register Yarbo WebSocket commands once per Home Assistant instance."""
    if hass.data.get(_REGISTERED_KEY):
        return
    websocket_api.async_register_command(hass, _handle_devices)
    websocket_api.async_register_command(hass, _handle_map_zones)
    websocket_api.async_register_command(hass, _handle_smart_vision)
    hass.data[_REGISTERED_KEY] = True


@callback
def async_describe_devices(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Describe each Yarbo device and its enabled entities, for dashboard cards.

    Entities are keyed by ``<domain>.<unique ID without the serial prefix>``, for
    example ``sensor.batterymsg_capacity``. Cards look entities up by these keys,
    so they keep working when the user renames an entity ID.
    """
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    devices: list[dict[str, Any]] = []
    for coordinator in hass.data.get(DOMAIN, {}).values():
        for device in coordinator.devices:
            entry = dev_reg.async_get_device(identifiers={(DOMAIN, device.sn)})
            if entry is None:
                continue
            prefix = f"{device.sn}_"
            entities = {
                f"{entity.domain}.{entity.unique_id.removeprefix(prefix)}": entity.entity_id
                for entity in er.async_entries_for_device(ent_reg, entry.id)
                if entity.platform == DOMAIN and entity.unique_id.startswith(prefix)
            }
            devices.append(
                {
                    "device_id": entry.id,
                    "sn": device.sn,
                    "name": entry.name_by_user or entry.name,
                    "model": entry.model,
                    "entities": entities,
                }
            )
    return devices


@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_DEVICES})
@callback
def _handle_devices(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """List Yarbo devices and the entities a dashboard card needs for each."""
    connection.send_result(msg["id"], {"devices": async_describe_devices(hass)})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_SMART_VISION,
        vol.Required("sn"): str,
    }
)
@websocket_api.async_response
async def _handle_smart_vision(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the Agora credentials a card needs to play a device's live feed."""
    sn = msg["sn"]
    for coordinator in hass.data.get(DOMAIN, {}).values():
        if not any(device.sn == sn for device in coordinator.devices):
            continue
        try:
            credentials = await coordinator.async_get_smart_vision_credentials(sn)
        except SmartVisionError as err:
            connection.send_error(msg["id"], "smart_vision_unavailable", str(err))
            return
        connection.send_result(msg["id"], credentials)
        return

    connection.send_error(
        msg["id"],
        websocket_api.const.ERR_NOT_FOUND,
        f"No Yarbo device with sn={sn}",
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_MAP_ZONES,
        vol.Required("sn"): str,
    }
)
@callback
def _handle_map_zones(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the full GeoJSON map and center coordinate for a device serial."""
    sn = msg["sn"]
    for coordinator in hass.data.get(DOMAIN, {}).values():
        geojson = coordinator.map_data.get(sn)
        if geojson is None:
            continue

        ref = coordinator.gps_refs.get(sn, {}).get("ref", {})
        center = None
        if ref.get("latitude") is not None:
            center = {
                "latitude": ref["latitude"],
                "longitude": ref["longitude"],
            }

        connection.send_result(
            msg["id"],
            {"sn": sn, "geojson": geojson, "center": center},
        )
        return

    connection.send_error(
        msg["id"],
        websocket_api.const.ERR_NOT_FOUND,
        f"No map data available for sn={sn}",
    )

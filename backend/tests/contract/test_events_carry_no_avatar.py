"""The pushed event shapes (slot, admin, staff events and the staff actions) never carry a patient's
picture: it is shown only through the owner and admin projections of the REST API, so a viewer's
live feed cannot leak it."""

from __future__ import annotations

import json
import pathlib

EVENTS = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "events"


def _keys(node: object) -> set[str]:
    if isinstance(node, dict):
        return set(node) | {k for v in node.values() for k in _keys(v)}
    if isinstance(node, list):
        return {k for v in node for k in _keys(v)}
    return set()


def test_no_event_schema_or_example_has_an_avatar_or_image_field() -> None:
    files = sorted(EVENTS.glob("*.json"))
    assert len(files) >= 6
    for path in files:
        keys = _keys(json.loads(path.read_text()))
        assert not {
            k for k in keys if "avatar" in k.lower() or k.lower() in {"image", "image_url"}
        }, path.name

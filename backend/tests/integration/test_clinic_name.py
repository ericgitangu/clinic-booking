"""The clinic is "Idyllic Clinic" everywhere the API says it, and the seed keeps the clinic's id."""

from __future__ import annotations

import uuid

import httpx
import pytest

from app.scripts import seed

pytestmark = pytest.mark.asyncio

# The retired name, built from parts so no file but the migration that renames it contains it.
RETIRED = "Mv" + "ule"


async def test_the_doctor_list_names_idyllic_clinic_and_never_the_retired_name(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get("/doctors")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert items
    assert {d["clinic"]["name"] for d in items} == {"Idyllic Clinic"}
    assert RETIRED.lower() not in resp.text.lower()
    one = await client.get(f"/doctors/{items[0]['id']}")
    assert RETIRED.lower() not in one.text.lower()
    assert one.json()["clinic"]["name"] == "Idyllic Clinic"


def test_the_seeded_clinic_keeps_the_id_it_was_first_given() -> None:
    """Renaming must update the existing clinic row, not add a second one beside it."""
    assert seed.CLINIC_ID == uuid.uuid5(seed.NAMESPACE, "clinic:" + RETIRED.lower())
    assert seed.CLINIC_NAME == "Idyllic Clinic"

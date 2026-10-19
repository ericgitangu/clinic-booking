"""The documents say what the code does about staff and the one-hour rule."""

from __future__ import annotations

import json
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[3]

# Phrases that were true before the staff exemption was built and are false now.
STALE = [
    "staff follow the same rule",
    "staff are held to the same rule",
    "staff are held to the one-hour rule",
    "held to the rule too, with no override",
    "Declared, not built",
]
DOCS = [
    "README.md",
    "docs/adr/0033-staff-crud-veto-and-invites.md",
    "docs/api-errors.md",
]


@pytest.mark.parametrize("name", DOCS)
def test_no_document_still_says_staff_follow_the_rule(name: str) -> None:
    text = (ROOT / name).read_text().replace("\n", " ")
    lowered = text.lower()
    for phrase in STALE:
        if name.endswith("0033-staff-crud-veto-and-invites.md") and phrase == "Declared, not built":
            continue  # the build-status line names its own history
        assert phrase.lower() not in lowered, f"{name} still says: {phrase}"


def test_the_staff_routes_state_the_exemption_in_the_contract() -> None:
    spec = json.loads((ROOT / "contracts" / "openapi.json").read_text())
    for path in (
        "/internal/admin/appointments/{appointment_id}/cancel",
        "/internal/admin/appointments/{appointment_id}/reschedule",
    ):
        description = spec["paths"][path]["patch"]["description"]
        assert "exempt from the lead-time rule and only from it" in description
        assert "SLOT_TAKEN" in description and "OUTSIDE_WORKING_HOURS" in description


def test_the_readme_and_the_adrs_name_what_staff_are_exempt_from() -> None:
    readme = (ROOT / "README.md").read_text()
    assert "Staff are exempt from this lead-time rule and from nothing else" in readme
    adr = (ROOT / "docs/adr/0033-staff-crud-veto-and-invites.md").read_text()
    assert "it is the only rule staff are exempt from" in adr

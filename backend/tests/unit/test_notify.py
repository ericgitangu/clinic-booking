from __future__ import annotations

import json
import pathlib

import pytest

from app.domain.notify import is_demo_recipient, outcome_for

FIXTURE = json.loads(
    (pathlib.Path(__file__).resolve().parents[3] / "contracts" / "demo-recipients.json").read_text()
)


@pytest.mark.parametrize("email", FIXTURE["demo"])
def test_a_demo_recipient_is_recognised(email: str) -> None:
    assert is_demo_recipient(email) is True
    assert outcome_for(email) == "demo, not sent"


@pytest.mark.parametrize("email", FIXTURE["real"])
def test_a_real_address_is_not_a_demo_recipient(email: str) -> None:
    assert is_demo_recipient(email) is False
    assert outcome_for(email) == "to send"


def test_the_fixture_has_the_agreed_sizes() -> None:
    assert (len(FIXTURE["demo"]), len(FIXTURE["real"])) == (15, 9)


def test_outcomes() -> None:
    assert outcome_for(None) == "no email on file"
    assert outcome_for("  ") == "no email on file"
    assert outcome_for("x@example.com") == "demo, not sent"
    assert outcome_for("x@gmail.com") == "to send"

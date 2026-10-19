from __future__ import annotations

import pytest

from app.domain.reasons import CATEGORIES, classify_reason


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("No matatu this morning", "transport"),
        ("Stuck in traffic and the bus broke down", "transport"),
        ("I have malaria and a fever", "illness"),
        ("Not feeling well today", "illness"),
        ("Travelling upcountry for a funeral", "travel"),
        ("Flight rescheduled", "travel"),
        ("Boss called a meeting", "work"),
        ("Work deadline", "work"),
        ("Heavy rain and flooding", "weather"),
        ("I feel much better now", "felt_better"),
        ("I was sick but I am better now", "felt_better"),
        ("Recovered, no longer need the visit", "felt_better"),
        ("NHIF cover has not been activated", "insurance"),
        ("Insurance pre-auth was declined", "insurance"),
        ("Clinic closed for the day (cancelled by clinic staff)", "other"),
        ("Doctor unavailable", "other"),
        ("   ", "other"),
        (None, "other"),
        ("The shape shall not wash out", "other"),
    ],
)
def test_classify_reason(text: str | None, want: str) -> None:
    assert classify_reason(text) == want


def test_every_result_is_a_known_category() -> None:
    for text in ("rain", "bus", "sick", "x", "insurance", "work", "trip", "better now"):
        assert classify_reason(text) in CATEGORIES


def test_the_staff_suffix_alone_says_nothing() -> None:
    assert classify_reason("(cancelled by clinic staff)") == "other"
    assert classify_reason("bus (cancelled by clinic staff)") == "transport"

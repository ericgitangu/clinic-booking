"""Every place that describes the one-hour rule says the same thing.

422 BOOKING_TOO_SOON is for a too-soon slot: a booking, or a reschedule's NEW time (validated as a
fresh booking). 409 CHANGE_TOO_LATE is for changing or cancelling a visit whose CURRENT start is
within the hour. An earlier draft said a reschedule's new slot is a 409; this fails if any surface
(README, docs, the ADRs, the apps' copy, the landing page evidence, the OpenAPI contract, the
catalogue) says that again. A sentence that mentions a new slot and a 409 / CHANGE_TOO_LATE must
also name the 422 / BOOKING_TOO_SOON it contrasts with, and a few exact old phrasings are banned.
"""

from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]

TEXT_FILES = [
    "README.md",
    "apps/booking/src/lib/evidence.ts",
    "apps/booking/src/lib/problems.ts",
    "apps/admin/src/lib/actions.ts",
    "backend/app/domain/errors.py",
    "backend/app/domain/booking_rules.py",
    "backend/app/api/routers/appointments.py",
    "backend/app/schemas/problem.py",
]
JSON_FILES = ["contracts/openapi.json", "apps/booking/src/generated/openapi.public.json"]

CHANGE = re.compile(r"CHANGE_TOO_LATE|\b409\b")
NEW_SLOT = re.compile(
    r"new (start|time|slot)|reschedule'?s? new|from or to|both its current start and the new",
    re.IGNORECASE,
)
TOO_SOON = re.compile(r"\b422\b|BOOKING_TOO_SOON")
BANNED = (
    "422 on book, 409 on change",
    "a reschedule is a change, so its new time",
    "moved to a time less than an hour away",
    "reschedule from or to",
    "cancel, or reschedule from or to",
    "(both its current start and the new start)",
    "no changes within 1 hour",
)


def _docs() -> list[pathlib.Path]:
    out = [p for p in (ROOT / "docs").rglob("*.md") if "internal" not in p.parts]
    return sorted(out)


def _segments(text: str) -> list[str]:
    parts: list[str] = []
    for line in text.splitlines():
        parts.extend(re.split(r"(?<=[.;])\s+(?=[A-Z`*(])", line))
    return parts


def _json_strings(node: object) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [s for v in node.values() for s in _json_strings(v)]
    if isinstance(node, list):
        return [s for v in node for s in _json_strings(v)]
    return []


def _surfaces() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for rel in TEXT_FILES:
        found.append((rel, (ROOT / rel).read_text()))
    for path in _docs():
        found.append((path.relative_to(ROOT).as_posix(), path.read_text()))
    for rel in JSON_FILES:
        spec = json.loads((ROOT / rel).read_text())
        found.append((rel, "\n".join(_json_strings(spec))))
    return found


def violations(surfaces: list[tuple[str, str]]) -> list[str]:
    bad: list[str] = []
    for name, text in surfaces:
        for phrase in BANNED:
            if phrase in text and not _is_dated_history(name, text, phrase):
                bad.append(f"{name}: banned phrase {phrase!r}")
        for seg in _segments(text):
            if CHANGE.search(seg) and NEW_SLOT.search(seg) and not TOO_SOON.search(seg):
                bad.append(f"{name}: new slot paired with 409/CHANGE_TOO_LATE: {seg[:120]!r}")
    return bad


def _is_dated_history(name: str, text: str, phrase: str) -> bool:
    """The ADRs are history: an old sentence may stay if a dated amendment (2026-10-19 or later)
    corrects it. None of the banned phrases is allowed in the amendment itself."""
    if not name.startswith("docs/adr/"):
        return False
    head, _, amendment = text.partition("(2026-10-19)")
    return bool(amendment) and phrase not in amendment and phrase in head


def test_no_surface_says_a_reschedules_new_slot_is_a_409() -> None:
    assert violations(_surfaces()) == []


def test_the_rule_is_stated_the_same_way_where_it_is_described() -> None:
    readme = (ROOT / "README.md").read_text()
    assert "`422 BOOKING_TOO_SOON` for a too-soon slot" in readme
    assert (
        "`409 CHANGE_TOO_LATE` for changing or cancelling a visit that starts within the hour"
        in readme
    )
    api_errors = (ROOT / "docs/api-errors.md").read_text()
    assert "422 BOOKING_TOO_SOON" in api_errors and "409 CHANGE_TOO_LATE" in api_errors
    adr = (ROOT / "docs/adr/0008-appointment-lifecycle-and-reschedule.md").read_text()
    assert "its new start stays `422 BOOKING_TOO_SOON`" in adr


def test_the_checker_catches_the_old_wording() -> None:
    """Mutation guard: the sentences of the earlier draft must be flagged."""
    old = [
        (
            "README.md",
            "- reschedule: `409 CHANGE_TOO_LATE` when the current start or the new start "
            "is under 60 minutes away.",
        ),
        (
            "contracts/openapi.json",
            "Refused with 409 CHANGE_TOO_LATE when the appointment (both "
            "its current start and the new start) begins less than 60 minutes from now.",
        ),
        ("docs/api-errors.md", "Cancel, or reschedule from or to, a time under 60 minutes away."),
        ("docs/adr/0008-x.md", "The contract in one line is **422 on book, 409 on change**."),
    ]
    for name, text in old:
        assert violations([(name, text)]), name
    fine = [
        (
            "README.md",
            "`409 CHANGE_TOO_LATE` for the current start, `422 BOOKING_TOO_SOON` "
            "when the new start is.",
        )
    ]
    assert violations(fine) == []

"""Every place that describes the one-hour rule says the same thing.

422 BOOKING_TOO_SOON is for a too-soon slot: a booking, or a reschedule's NEW time (validated as a
fresh booking). 409 CHANGE_TOO_LATE is for changing or cancelling a visit whose CURRENT start is
within the hour. An earlier draft said a reschedule's new slot is a 409; this fails if any surface
(README, docs, the ADRs, the apps' copy, the landing page evidence, the OpenAPI contract, the
catalogue) says that again. A sentence (or a whole wrapped paragraph) that talks about moving or
rescheduling to a new time and carries a 409 / CHANGE_TOO_LATE / "conflict" must also name the
422 / BOOKING_TOO_SOON it contrasts with; paraphrases, word order and line wraps do not get past it,
and a few exact old phrasings are banned. The apps' copy modules, their action components, the
reschedule page, the landing evidence, the generated client and the served problem text are all
scanned. ``test_every_surface_catches_a_planted_paraphrase`` plants one in each of them.
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
    "apps/booking/src/lib/change-window.ts",
    "apps/booking/src/components/booking/appointment-actions.tsx",
    "apps/booking/src/app/appointments/[id]/reschedule/page.tsx",
    "apps/admin/src/lib/actions.ts",
    "apps/admin/src/components/appointment-actions.tsx",
    "packages/api/src/generated/types.gen.ts",
    "packages/api/src/generated/sdk.gen.ts",
    "backend/app/domain/errors.py",
    "backend/app/domain/booking_rules.py",
    "backend/app/api/routers/appointments.py",
    "backend/app/schemas/problem.py",
]
JSON_FILES = ["contracts/openapi.json", "apps/booking/src/generated/openapi.public.json"]

RESCHEDULING = re.compile(r"reschedul|\bmov(e|es|ed|ing)\b|\bchang(e|es|ed|ing)\b", re.IGNORECASE)
# A 409 that names another code (ALREADY_CANCELLED, SLOT_TAKEN, ...) is not the lead-time 409.
CONFLICT = re.compile(
    r"CHANGE_TOO_LATE|conflict|\b409\b(?![ `*]*(APPOINTMENT_ALREADY|SLOT_TAKEN|PATIENT_|CONCURRENT"
    r"|IDEMPOTENCY|ACCESS|OWNER))",
    re.IGNORECASE,
)
NEW_SLOT = re.compile(
    r"\bnew\b[^.;]{0,25}(start|time|slot)|target|destination|from or to|"
    r"both its current start and the new|\bto (a|an|another)\b[^.;]{0,30}(time|slot|start)|"
    r"\bto\b[^.;]{0,40}(minutes?|hour) away|reschedul\w*\s+to\b|moved? to\b|moving to\b",
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


def _clean(line: str) -> str:
    """Drop comment and markdown markers so a wrapped comment reads as the sentence it is."""
    return re.sub(r"^\s*(//+|/?\*+/?|#+|[-*>]|\d+\.)\s?", "", line).strip()


def _segments(text: str) -> list[str]:
    """Sentences and whole paragraphs (a list item is its own paragraph), with line wraps joined."""
    parts: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        groups: list[list[str]] = []
        previous = ""
        for line in block.splitlines():
            after_table_row = bool(previous.strip().startswith("|"))
            if not groups or after_table_row or re.match(r"\s*([-*|]|\d+\.)\s?", line):
                groups.append([])
            previous = line
            groups[-1].append(_clean(line))
        for group in groups:
            paragraph = " ".join(filter(None, group))
            parts.append(paragraph)
            parts.extend(re.split(r"(?<=[.;])\s+(?=\S)", paragraph))
    return parts


CODE_SUFFIXES = (".ts", ".tsx", ".py")
_LITERAL = re.compile(
    r'"""(?:.|\n)*?"""|\'\'\'(?:.|\n)*?\'\'\'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'',
)
_COMMENT = re.compile(r"(?m)^\s*(?://|#|\*|/\*)\s?(.*)$")


def _trailing_comment(line: str) -> str | None:
    """The comment after code on the same line (``code, // comment`` or ``code  # comment``),
    found outside string literals."""
    quote = ""
    for i, ch in enumerate(line):
        if quote:
            if ch == quote and line[i - 1] != "\\":
                quote = ""
        elif ch in "\"'`":
            quote = ch
        elif line.startswith("//", i) or ch == "#" or line.startswith("/*", i):
            return line[i:].lstrip("/#* ").rstrip("*/ ").strip() or None
    return None


def _code_segments(text: str) -> list[str]:
    """For source files, each string literal and each comment line is a segment of its own, so a
    wrong sentence cannot hide next to a correct one in the same block, array or template."""
    parts: list[str] = []
    for literal in _LITERAL.findall(text):
        body = re.sub(r'^(\"\"\"|\'\'\'|[`"\'])|(\"\"\"|\'\'\'|[`"\'])$', "", literal)
        body = " ".join(line.strip() for line in body.splitlines())
        parts.append(body)
        parts.extend(re.split(r"(?<=[.;])\s+(?=[A-Z`*(])", body))
    for line in _COMMENT.findall(text):
        parts.append(line)
    for line in text.splitlines():
        trailing = _trailing_comment(line)
        if trailing:
            parts.append(trailing)
            parts.extend(re.split(r"(?<=[.;])\s+(?=\S)", trailing))
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


def _paraphrase(segment: str) -> bool:
    return bool(
        RESCHEDULING.search(segment)
        and CONFLICT.search(segment)
        and NEW_SLOT.search(segment)
        and not TOO_SOON.search(segment)
    )


def violations(surfaces: list[tuple[str, str]]) -> list[str]:
    bad: list[str] = []
    for name, text in surfaces:
        for phrase in BANNED:
            if phrase in text and not _is_dated_history(name, text, phrase):
                bad.append(f"{name}: banned phrase {phrase!r}")
        segments = _code_segments(text) if name.endswith(CODE_SUFFIXES) else []
        for seg in segments + _segments(text):
            if _paraphrase(seg):
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


PARAPHRASES = [
    "A reschedule to a new time under an hour away is a 409.",
    "Moving a visit to a time\n// under an hour away\n// answers CHANGE_TOO_LATE.",
    "CHANGE_TOO_LATE also covers the target slot of a reschedule.",
    "When the destination slot of a move is too soon the result is a conflict.",
    "The new start of a reschedule that is inside the hour comes back as 409.",
]


def test_every_surface_catches_a_planted_paraphrase() -> None:
    """Mutation proof: a paraphrase planted in ANY scanned surface (the four that once slipped
    through, the patient app's copy and both apps' action components, the reschedule page, the
    landing evidence, the generated client, the catalogue and the OpenAPI strings) is reported."""
    surfaces = _surfaces()
    assert violations(surfaces) == []
    names = {name for name, _ in surfaces}
    for must in (
        "README.md",
        "docs/api-errors.md",
        "apps/booking/src/lib/change-window.ts",
        "apps/booking/src/components/booking/appointment-actions.tsx",
        "apps/admin/src/components/appointment-actions.tsx",
        "apps/booking/src/app/appointments/[id]/reschedule/page.tsx",
        "apps/booking/src/lib/problems.ts",
        "apps/booking/src/lib/evidence.ts",
        "apps/admin/src/lib/actions.ts",
        "packages/api/src/generated/types.gen.ts",
        "contracts/openapi.json",
        "backend/app/domain/errors.py",
    ):
        assert must in names, f"{must} is not scanned"
    for name, text in surfaces:
        for planted in PARAPHRASES:
            assert violations([(name, f"{text}\n\n{planted}\n")]), (name, planted)


WRONG = "A reschedule to a new time under an hour away is refused with 409 CHANGE_TOO_LATE."


def _plant_mid_block(name: str, text: str) -> list[str]:
    """The wrong sentence dropped into the middle of an existing block, on the lines around the
    first mention of BOOKING_TOO_SOON (or the middle of the file): as a string literal, a template
    literal, a comment, and replacing the neighbouring line."""
    lines = text.splitlines()
    at = next((i for i, line in enumerate(lines) if "BOOKING_TOO_SOON" in line), len(lines) // 2)
    variants: list[str] = []
    if name.endswith(CODE_SUFFIXES):
        shapes = [f'  "{WRONG}",', f"  `{WRONG}`,", f"  // {WRONG}", f'  summary: "{WRONG}",']
    elif name.endswith(".json"):
        shapes = [WRONG]
    else:
        shapes = [WRONG]
    if name.endswith(CODE_SUFFIXES):
        marker = "#" if name.endswith(".py") else "//"
        # The wrong sentence as a trailing comment on a line that itself names BOOKING_TOO_SOON.
        trailing = list(lines)
        trailing[at] = f"{trailing[at]} {marker} {WRONG}"
        variants.append("\n".join(trailing))
    for shape in shapes:
        for offset in (0, 1):
            planted = lines[: at + offset] + [shape] + lines[at + offset :]
            variants.append("\n".join(planted))
        replaced = list(lines)
        if replaced:
            replaced[at] = shape
        variants.append("\n".join(replaced))
    return variants


def test_a_wrong_sentence_planted_mid_block_is_caught_in_every_surface() -> None:
    surfaces = _surfaces()
    assert violations(surfaces) == []
    for name, text in surfaces:
        if name.endswith(".json"):
            continue  # the JSON surfaces are flattened to their strings; covered by the EOF plant
        for variant in _plant_mid_block(name, text):
            assert violations([(name, variant)]), (name, variant[:0])


def test_no_waiver_lets_a_wrong_sentence_through() -> None:
    """A wrong sentence is caught whatever else it says (the old waiver let 'already happened'
    through), and the scanner has no allow-list at all."""
    readme = (ROOT / "README.md").read_text()
    for tail in (
        f"{WRONG[:-1]}, even if it already happened.",
        f"{WRONG[:-1]}, and the appointment is returned.",
        f"{WRONG[:-1]} (same new start).",
    ):
        assert violations([("README.md", f"{readme}\n\n{tail}\n")]), tail
    assert not any(name.upper().startswith(("SAFE", "WAIVER", "ALLOW")) for name in globals())

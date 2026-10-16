from __future__ import annotations

import pathlib

from app.domain.errors import (
    CATALOGUE,
    CATALOGUE_BY_CODE,
    BookingTooSoon,
    DateOutOfRange,
    DomainError,
    OutsideWorkingHours,
    SlotInPast,
    SlotMisaligned,
)

DOCS = pathlib.Path(__file__).resolve().parents[3] / "docs" / "api-errors.md"

DOMAIN_ERRORS: list[type[DomainError]] = [
    SlotInPast,
    BookingTooSoon,
    DateOutOfRange,
    SlotMisaligned,
    OutsideWorkingHours,
]


def _parse_docs() -> list[tuple[str, int, str, str]]:
    rows: list[tuple[str, int, str, str]] = []
    for line in DOCS.read_text().splitlines():
        if not line.startswith("| "):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5 or cells[0] in {"Code", "---"}:
            continue
        code, status, slug, title = cells[0], cells[1], cells[2], cells[3]
        if not status.isdigit():
            continue
        rows.append((code, int(status), slug, title))
    return rows


def test_catalogue_matches_docs() -> None:
    doc_rows = {(c, s, sl, t) for (c, s, sl, t) in _parse_docs()}
    cat_rows = {(spec.code, spec.status, spec.slug, spec.title) for spec in CATALOGUE}
    assert doc_rows == cat_rows, f"docs vs code mismatch: {doc_rows ^ cat_rows}"


def test_every_domain_error_is_in_catalogue() -> None:
    for exc_cls in DOMAIN_ERRORS:
        exc = exc_cls()
        assert exc.code in CATALOGUE_BY_CODE
        spec = CATALOGUE_BY_CODE[exc.code]
        assert exc.status == spec.status
        assert exc.title == spec.title
        assert exc.slug == spec.slug


def test_slugs_are_kebab_case() -> None:
    for spec in CATALOGUE:
        assert spec.slug == spec.code.lower().replace("_", "-")
        assert "_" not in spec.slug


def test_default_detail_falls_back_to_description() -> None:
    assert SlotInPast().detail == CATALOGUE_BY_CODE["SLOT_IN_PAST"].description
    assert SlotInPast("custom").detail == "custom"

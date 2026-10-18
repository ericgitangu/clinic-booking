from __future__ import annotations

import ast
import importlib
import pathlib
import pkgutil

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
from app.schemas.problem import ProblemCode

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


# --- every code the API can emit is catalogued and documented ------------------------------

APP_DIR = pathlib.Path(__file__).resolve().parents[2] / "app"


def _import_all_app_modules() -> None:
    import app

    for mod in pkgutil.walk_packages(app.__path__, prefix="app."):
        importlib.import_module(mod.name)


def _all_domain_error_classes() -> list[type[DomainError]]:
    _import_all_app_modules()
    found: list[type[DomainError]] = []
    stack: list[type[DomainError]] = [DomainError]
    while stack:
        for sub in stack.pop().__subclasses__():
            found.append(sub)
            stack.append(sub)
    return found


def _codes_named_in_source() -> set[str]:
    """String literals passed as the code to build_problem(...) anywhere under app/."""
    codes: set[str] = set()
    for path in APP_DIR.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name == "build_problem" and len(node.args) >= 2:
                # Any string literal inside the code argument, including a conditional's arms.
                for sub in ast.walk(node.args[1]):
                    if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                        codes.add(sub.value)
    return codes


def _handler_variable_codes() -> set[str]:
    """Literals assigned to a local named ``code`` in app/core/problems.py (the handlers pick the
    code with a conditional and pass the variable on)."""
    codes: set[str] = set()
    tree = ast.parse((APP_DIR / "core" / "problems.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "code" for t in node.targets
        ):
            for sub in ast.walk(node.value):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                    codes.add(sub.value)
    return codes


def test_every_domain_error_class_in_the_app_is_catalogued_and_documented() -> None:
    documented = {code for code, *_ in _parse_docs()}
    classes = _all_domain_error_classes()
    assert len(classes) >= 25, "the walk should find the whole hierarchy"
    for cls in classes:
        assert cls.code in CATALOGUE_BY_CODE, f"{cls.__name__} raises uncatalogued {cls.code}"
        assert cls.code in documented, f"{cls.code} missing from docs/api-errors.md"


def test_every_code_named_in_a_handler_is_catalogued_and_documented() -> None:
    documented = {code for code, *_ in _parse_docs()}
    named = _codes_named_in_source() | _handler_variable_codes()
    assert {"VALIDATION_ERROR", "NOT_FOUND", "INTERNAL_ERROR", "DB_UNAVAILABLE"} <= named
    assert named <= set(CATALOGUE_BY_CODE), named - set(CATALOGUE_BY_CODE)
    assert named <= documented, named - documented


def test_problem_code_enum_in_the_contract_matches_the_catalogue() -> None:
    assert {c.value for c in ProblemCode} == set(CATALOGUE_BY_CODE)


def test_every_catalogue_code_has_a_documented_row_with_the_same_status() -> None:
    documented = {code: status for code, status, _slug, _title in _parse_docs()}
    assert documented == {spec.code: spec.status for spec in CATALOGUE}

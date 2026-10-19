"""The apps disable cancel and reschedule inside the last hour using a constant of their own
(``CHANGE_LEAD_MINUTES``). The API is the authority (``BOOKING_MIN_LEAD_MINUTES``); this fails if
the two ever differ, or if a deploy file overrides the setting without the apps knowing."""

from __future__ import annotations

import os
import pathlib
import re

from app.core.config import Settings

ROOT = pathlib.Path(__file__).resolve().parents[3]
APP_FILES = [
    ROOT / "apps" / "booking" / "src" / "lib" / "change-window.ts",
    ROOT / "apps" / "admin" / "src" / "lib" / "change-window.ts",
]


def _app_constant(path: pathlib.Path) -> int:
    match = re.search(r"CHANGE_LEAD_MINUTES\s*=\s*(\d+)", path.read_text())
    assert match, f"CHANGE_LEAD_MINUTES not found in {path}"
    return int(match.group(1))


def test_both_apps_use_the_apis_lead_time() -> None:
    api = Settings(DATABASE_URL="postgresql+asyncpg://u:p@localhost/db").BOOKING_MIN_LEAD_MINUTES
    assert api == 60
    for path in APP_FILES:
        assert _app_constant(path) == api, path


SKIP_DIRS = {".next", ".venv", ".git", "node_modules", "test-results", "__pycache__"} | {
    ".drift-tmp",
    "generated",
}
# Where a deployed value could be set: workflow, compose, Terraform, scripts, env files,
# Dockerfiles, the Makefile, and the code that configures test or export runs (.ts, .js, .py).
CONFIG_SUFFIXES = {".yml", ".yaml", ".tf", ".tfvars", ".sh", ".env", ".example", ".toml", ".json"}
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}
PROSE_PREFIXES = ("docs/", "contracts/", "backend/app/", "backend/tests/")


def _config_files() -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]  # prune: never enter them
        for name in filenames:
            path = pathlib.Path(dirpath) / name
            rel = path.relative_to(ROOT).as_posix()
            if rel.startswith(PROSE_PREFIXES):
                continue  # prose and the contract mention the name; the code defines the default
            suffix = path.suffix
            if (
                name.startswith(("Dockerfile", "Makefile"))
                or suffix in CONFIG_SUFFIXES | CODE_SUFFIXES
            ):
                found.append(path)
    return found


# Only an assignment to the setting counts: NAME=45, NAME: 45, NAME = "45", NAME"] = "45", and a
# Terraform / task-definition pair (name = "NAME" then value = "45"). A mention in a comment or in
# prose ("BOOKING_MIN_LEAD_MINUTES is described in the docs") is not an assignment.
ASSIGNMENT = re.compile(r"BOOKING_MIN_LEAD_MINUTES[\"'\]]*[ \t]*[:=][ \t]*[\"']?([^\s\"',)}]*)")
BLOCK = re.compile(
    r"name\s*=\s*[\"']BOOKING_MIN_LEAD_MINUTES[\"']\s*[,\n]\s*value\s*=\s*[\"']?([^\s\"',)}]*)"
)


def lead_assignments(text: str) -> list[str]:
    """Every value the text assigns to the setting, as written."""
    return [m.group(1) for m in ASSIGNMENT.finditer(text)] + [
        m.group(1) for m in BLOCK.finditer(text)
    ]


def test_assignment_matrix() -> None:
    assigned = {
        "BOOKING_MIN_LEAD_MINUTES=45": ["45"],
        "  BOOKING_MIN_LEAD_MINUTES: 45": ["45"],
        'BOOKING_MIN_LEAD_MINUTES = "45"': ["45"],
        'process.env.BOOKING_MIN_LEAD_MINUTES = "45";': ["45"],
        'os.environ["BOOKING_MIN_LEAD_MINUTES"] = "45"': ["45"],
        "Settings(BOOKING_MIN_LEAD_MINUTES=45)": ["45"],
        "--set-env-vars BOOKING_MIN_LEAD_MINUTES=45,X=1": ["45"],
        'name  = "BOOKING_MIN_LEAD_MINUTES"\n  value = "45"': ["45"],
        "BOOKING_MIN_LEAD_MINUTES=${LEAD}": ["${LEAD"],
        "BOOKING_MIN_LEAD_MINUTES=60": ["60"],
    }
    for text, want in assigned.items():
        assert lead_assignments(text)[:1] == want, text
    prose = [
        "// BOOKING_MIN_LEAD_MINUTES is described in the docs.",
        "The setting BOOKING_MIN_LEAD_MINUTES (60 minutes by default) limits it.",
        "# see BOOKING_MIN_LEAD_MINUTES, 2026-10-18",
        "BOOKING_MIN_LEAD_MINUTES and 60 minutes",
    ]
    for text in prose:
        assert lead_assignments(text) == [], text


def test_no_config_file_sets_a_different_lead_time() -> None:
    """A file may assign the default (``BOOKING_MIN_LEAD_MINUTES=60``); none may set another value,
    and an assignment whose value cannot be read as a number is refused."""
    files = _config_files()
    assert any(f.name == "config.yml" for f in files), "the scan found the CircleCI config"
    api = Settings(DATABASE_URL="postgresql+asyncpg://u:p@localhost/db").BOOKING_MIN_LEAD_MINUTES
    for path in files:
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        for value in lead_assignments(text):
            where = path.relative_to(ROOT)
            assert value.isdigit(), (where, "the value cannot be read", value)
            assert int(value) == api, (where, value)

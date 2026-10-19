"""The apps hide cancel and reschedule inside the last hour using a constant of their own
(``CHANGE_LEAD_MINUTES``). The API is the authority (``BOOKING_MIN_LEAD_MINUTES``); this fails if
the two ever differ, or if a deploy file overrides the setting without the apps knowing."""

from __future__ import annotations

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
# Where a deployed value could be set: workflow, compose, Terraform, scripts, env, Dockerfiles.
CONFIG_SUFFIXES = {".yml", ".yaml", ".tf", ".tfvars", ".sh", ".env", ".example", ".toml", ".json"}


def _config_files() -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or SKIP_DIRS & set(path.relative_to(ROOT).parts):
            continue
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith(("docs/", "contracts/", "backend/app/", "backend/tests/")):
            continue  # prose and the contract mention the name; the code defines the default
        if path.name.startswith(("Dockerfile", "Makefile")) or path.suffix in CONFIG_SUFFIXES:
            found.append(path)
    return found


def test_no_config_file_sets_a_different_lead_time() -> None:
    """A file may document the default (``BOOKING_MIN_LEAD_MINUTES=60``); none may set another."""
    files = _config_files()
    assert any(f.name == "config.yml" for f in files), "the scan found the CircleCI config"
    api = Settings(DATABASE_URL="postgresql+asyncpg://u:p@localhost/db").BOOKING_MIN_LEAD_MINUTES
    for path in files:
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        for match in re.finditer("BOOKING_MIN_LEAD_MINUTES", text):
            # The value follows the name: `NAME=45`, `NAME: 45`, or a Terraform / task-definition
            # block (`name = "NAME"` then `value = "45"`). Whatever form, the next number is it.
            tail = text[match.end() : match.end() + 120]
            number = re.search(r"\d+", tail)
            where = path.relative_to(ROOT)
            assert number, (where, "the setting is named but its value cannot be read")
            assert int(number.group(0)) == api, (where, tail[:60])

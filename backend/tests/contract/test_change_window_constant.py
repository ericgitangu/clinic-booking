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


def test_no_deploy_file_overrides_the_lead_time() -> None:
    for name in (".circleci/config.yml", "docker-compose.yml", "infra/bootstrap.sh"):
        path = ROOT / name
        if path.exists():
            assert "BOOKING_MIN_LEAD_MINUTES" not in path.read_text(), name

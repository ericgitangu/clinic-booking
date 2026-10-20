"""The clinic's zone lives in the database (``clinics.timezone``) and is written there by
the seed from ``app.scripts.seed.CLINIC_TZ``. Each Next.js app keeps a ``CLINIC_TZ`` constant of
its own for the day boundaries and the times it shows. This fails if any of the three differ, so
the apps cannot drift from the clinic's zone. It is static: it reads the seed and the two source
files, with no database."""

from __future__ import annotations

import pathlib
import re
from zoneinfo import ZoneInfo

from app.scripts.seed import CLINIC_TZ as SEEDED_CLINIC_TZ

ROOT = pathlib.Path(__file__).resolve().parents[3]
APP_FILES = [
    ROOT / "apps" / "admin" / "src" / "lib" / "clinic-time.ts",
    ROOT / "apps" / "booking" / "src" / "lib" / "clinic-time.ts",
]


def _app_constant(path: pathlib.Path) -> str:
    match = re.search(r"""export const CLINIC_TZ\s*=\s*["']([^"']+)["']""", path.read_text())
    assert match, f"CLINIC_TZ not found in {path}"
    return match.group(1)


def test_the_seeded_zone_is_a_real_iana_zone() -> None:
    ZoneInfo(SEEDED_CLINIC_TZ)  # raises ZoneInfoNotFoundError if not


def test_both_apps_use_the_clinics_zone() -> None:
    for path in APP_FILES:
        assert _app_constant(path) == SEEDED_CLINIC_TZ, path

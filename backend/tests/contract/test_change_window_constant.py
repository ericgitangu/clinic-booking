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


# The one file allowed to set a different lead time, and the only value it may set. It starts a
# second API for the reviewer collection's CHANGE_TOO_LATE folder (a visit booked for tomorrow is
# inside a 100-day lead), so the rule can be shown at any hour without writing to the database
# outside the API. It is test-only: see test_the_test_only_lead_time_is_never_deployed.
TEST_ONLY_LEAD = {"scripts/api_check.compose.yml": 144000}
# Files that may name that file: the runner, the generator (its folder text), and the CI job that
# runs the runner. Nothing that builds or deploys an image or infrastructure may.
TEST_ONLY_LEAD_USERS = {
    "scripts/api_check.sh",
    "scripts/api_collection.mjs",
    "scripts/ci/test_ci_scripts.sh",
    ".circleci/config.yml",
    "backend/tests/contract/test_change_window_constant.py",
}


def test_no_config_file_sets_a_different_lead_time() -> None:
    """A file may assign the default (``BOOKING_MIN_LEAD_MINUTES=60``); none may set another value,
    and an assignment whose value cannot be read as a number is refused. The one test-only file in
    ``TEST_ONLY_LEAD`` may set its own value, and nothing else."""
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
            allowed = TEST_ONLY_LEAD.get(where.as_posix(), api)
            assert int(value) == allowed, (where, value)
    for rel, minutes in TEST_ONLY_LEAD.items():
        # An allowlisted file must really set its value: a stale entry would hide a later change.
        assert lead_assignments((ROOT / rel).read_text()) == [str(minutes)], rel


def test_the_test_only_lead_time_is_never_deployed() -> None:
    """The file that sets another lead time is named only by the reviewer-collection runner, its
    generator and the CI job that runs it: no Dockerfile, Terraform, release job or other script
    builds, ships or starts it."""
    for rel in TEST_ONLY_LEAD:
        name = pathlib.PurePosixPath(rel).name
        users: set[str] = set()
        for path in [*_config_files(), *ROOT.glob("**/Dockerfile*")]:
            if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
                continue
            try:
                if name in path.read_text():
                    users.add(path.relative_to(ROOT).as_posix())
            except UnicodeDecodeError:
                continue
        assert users <= TEST_ONLY_LEAD_USERS, (rel, sorted(users - TEST_ONLY_LEAD_USERS))
        # In the CI config it appears only inside the api-check job.
        config = (ROOT / ".circleci" / "config.yml").read_text()
        job = config[config.index("\n  api-check:\n") :]
        job = job[: job.index("\n  admin-e2e:\n")] if "\n  admin-e2e:\n" in job else job
        assert config.count(name) == job.count(name), (rel, "named outside the api-check job")

"""scripts/check_env_example.py: the example files may show local defaults, never a secret.

Credential-shaped strings below are assembled from pieces so the secret scanners do not flag this
file; none of them is a real key."""

from __future__ import annotations

import importlib.util
import pathlib
import subprocess
import sys
from types import ModuleType

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "check_env_example.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_env_example", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = _load()

HEX_KEY = "".join(["9f3c", "1ab0", "77e2", "d45c", "0b9a", "e13f", "5c28", "a6d1", "40fe", "b7c3"])
FAKE_SK = "".join(["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"])
FAKE_RE = "".join(["re", "_", "AbCdEf12_3456789xyz"])
FAKE_GHP = "".join(["gh", "p_", "16C7e42F292c6912E7710c838347Ae178B4a"])
FAKE_AIZA = "".join(["AI", "za", "SyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI"])
FAKE_XOX = "".join(["xo", "xb-", "263594206564-FGqddMF8t08v8N7Oq4i57vs1"])


def errors(text: str) -> list[str]:
    result: list[str] = check.value_errors("x/.env.example", text)
    return result


def test_the_real_example_files_pass() -> None:
    run = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False, cwd=ROOT
    )
    assert run.returncode == 0, run.stderr
    assert "env example check ok" in run.stdout


@pytest.mark.parametrize(
    "line",
    [
        "INTERNAL_SIGNING_KEY=abc",
        "BETTER_AUTH_SECRET=changeme",
        "TEST_OWNER_PASSWORD=clinic",
        "VERCEL_TOKEN='x'",
        'API_TOKEN="x"',
        "TEST_OWNER_DSN=postgres://localhost/clinic",
        "SOME_PRIVATE_THING=1",
        "GCP_CREDENTIALS=file.json",
        "BASIC_PASS=x",
        # Named in SECRET_NAMES: no secret word in the name, still a credential.
        "DATABASE_URL=postgresql+asyncpg://localhost/clinic",
        "E2E_DB_URL=postgres://127.0.0.1/clinic",
        "PURGE_DATABASE_URL=x",
        "GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com",
    ],
)
def test_a_secret_named_variable_with_a_value_fails(line: str) -> None:
    found = errors(f"# comment\n{line}\n")
    assert len(found) == 1, found
    assert "is a secret and must be empty" in found[0]
    assert ":2:" in found[0]


@pytest.mark.parametrize(
    "line",
    [
        "INTERNAL_SIGNING_KEY=",
        "BETTER_AUTH_SECRET=",
        "DATABASE_URL=",
        "VERCEL_TOKEN=''",
        # Rate limits on token issue are numbers, listed in NOT_SECRET_NAMES.
        "REALTIME_TOKEN_PER_MINUTE=10",
        "REALTIME_TOKEN_DAILY_CAP=500",
    ],
)
def test_an_empty_secret_or_a_listed_exception_passes(line: str) -> None:
    assert errors(line + "\n") == []


@pytest.mark.parametrize(
    ("line", "why"),
    [
        (f"API_URL={FAKE_SK}", "provider key prefix"),
        (f"RESEND_BASE_URL={FAKE_RE}", "provider key prefix"),
        (f"SOME_SETTING={FAKE_GHP}", "provider key prefix"),
        (f"SOME_SETTING={FAKE_AIZA}", "provider key prefix"),
        (f"SOME_SETTING={FAKE_XOX}", "provider key prefix"),
        ("API_URL=https://admin:hunter2@api.example.com", "URL with user:password"),
        ("REDIS_URL=redis://default:s3cr3tvalue@localhost:6379", "URL with user:password"),
        (f"GITLEAKS_SHA256={HEX_KEY}", "long high-entropy string"),
        (f"SOME_SETTING={HEX_KEY[:24]}", "long high-entropy string"),
    ],
    # Named ids: the default ids would write the fake keys into .pytest_cache.
    ids=["sk", "re", "ghp", "aiza", "xox", "https-userinfo", "redis-userinfo", "hex40", "hex24"],
)
def test_a_value_shaped_like_a_credential_fails(line: str, why: str) -> None:
    found = errors(line + "\n")
    assert len(found) == 1, found
    assert why in found[0]
    value = line.split("=", 1)[1]
    assert value not in found[0], "the message must not repeat the value"


@pytest.mark.parametrize(
    "comment",
    [
        f"# for example {FAKE_SK}",
        "# e.g. postgresql+asyncpg://clinic:clinic@localhost:5432/clinic",
    ],
    ids=["key-prefix", "url-userinfo"],
)
def test_a_comment_holding_a_credential_fails(comment: str) -> None:
    found = errors(comment + "\nNAME=\n")
    assert len(found) == 1, found
    assert "comment holds" in found[0]


@pytest.mark.parametrize(
    "line",
    [
        "WEB_ORIGIN=http://localhost:3000",
        "ABLY_STREAM_URL=https://main.realtime.ably.net/event-stream",
        "PROBE_STS_URL=https://sts.googleapis.com/v1/token",
        "TEST_FIXED_NOW=2026-10-19T04:00:00+00:00",
        "HEARTBEAT_INTERVAL=30s",
        "TF_VAR_github_repository=ericgitangu/clinic-booking",
        "HYGIENE_ALLOW=scripts/hygiene_allow.txt",
        "DEFAULT_CLINIC_TZ=Africa/Nairobi",
        "REALTIME_RELAY_TIMEOUT_SECONDS=2.0",
        # A format note in a comment: the password part is a placeholder.
        "# Format: postgresql+asyncpg://USER:PASSWORD@HOST:PORT/DB",
        "# Format: postgres://<user>:<password>@<host>/<db>",
        "# Generate one with: openssl rand -hex 32",
    ],
)
def test_ordinary_defaults_and_notes_pass(line: str) -> None:
    assert errors(line + "\n") == []


def test_main_fails_when_an_example_file_gains_a_secret(
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The whole check against the real repository, with copies of the real example files in
    place of the originals and one key filled in: names and stale checks pass, the value fails."""
    copies = {}
    for label, path in check.ENV_FILES.items():
        copy = tmp_path / label / ".env.example"
        copy.parent.mkdir()
        copy.write_text(path.read_text())
        copies[label] = copy
    with copies["backend"].open("a") as f:
        f.write(f"INTERNAL_SIGNING_KEY={HEX_KEY}\n")
    monkeypatch.setattr(check, "ENV_FILES", copies)

    assert check.main() == 1
    err = capsys.readouterr().err.splitlines()
    assert err[0] == "env example check failed:"
    assert len(err) == 2, err
    assert "INTERNAL_SIGNING_KEY is a secret and must be empty" in err[1]
    assert HEX_KEY not in err[1]

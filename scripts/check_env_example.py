#!/usr/bin/env python3
"""Fail when a variable read in code is missing from the .env.example files, or a listed name is stale.

Names only: no value is ever read from the environment or from a real .env file. The rules:

* backend/.env.example holds every Settings field (backend/app/core/config.py) plus PORT.
* services/realtime/.env.example holds every name the gateway reads (config.go and os.Getenv).
* apps/<app>/.env.example holds every process.env.X / env.X read under that app, and the root
  file holds the union of all of them.
* packages/api/src reads must appear in at least one app file (the apps import different parts).
* The root file also holds every Terraform variable (as TF_VAR_<name>), every required
  `${NAME:?...}` / defaulted `${NAME:-...}` in compose files, the CI config and the shell scripts
  under scripts/ci, plus infra/bootstrap.sh and scripts/cost_check.sh.
* No listed name may be unused: each must appear in tracked code outside the example files and docs.

Values: non-secret names carry their local default, so the files hold values, but never a secret.
* A secret-named variable (KEY, TOKEN, SECRET, PASSWORD, PASS, DSN, PRIVATE, CREDENTIAL in the name,
  or one of SECRET_NAMES) must be empty.
* No value, and nothing in a comment, may look like a real credential: a known key prefix (sk_, rk_,
  re_, ghp_, xox?-, AIza, ...), a URL with user:password, or (values only) a long high-entropy string.

Platform-set names (NODE_ENV, VERCEL, VERCEL_ENV, CI, CIRCLECI) and names CircleCI supplies (CIRCLE_*) are
documented in comments, not as assignments, so they are exempt.
"""

from __future__ import annotations

import ast
import math
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = {"NODE_ENV", "VERCEL", "VERCEL_ENV", "CI", "CIRCLECI", "BASH_ENV", "HOME", "PATH", "PWD"}
NAME = r"[A-Z][A-Z0-9_]+"
ENV_FILES = {
    "root": ROOT / ".env.example",
    "backend": ROOT / "backend/.env.example",
    "realtime": ROOT / "services/realtime/.env.example",
    "booking": ROOT / "apps/booking/.env.example",
    "admin": ROOT / "apps/admin/.env.example",
}
TS_SUFFIXES = (".ts", ".tsx", ".mjs", ".js", ".cjs", ".mts")

# Names that hold a credential without saying so in the name: connection strings with a password,
# and the OAuth client id the Vercel projects mark Sensitive.
SECRET_NAMES = {"DATABASE_URL", "PURGE_DATABASE_URL", "E2E_DB_URL", "GOOGLE_CLIENT_ID"}
SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASS|DSN|PRIVATE|CREDENTIAL")
# Names the pattern above catches that hold no secret: rate limits on how many live-update tokens
# are issued (numbers). Each entry is a deliberate exception; the credential-shape check still runs.
NOT_SECRET_NAMES = {"REALTIME_TOKEN_PER_MINUTE", "REALTIME_TOKEN_DAILY_CAP"}
# Provider key shapes: Stripe/Resend (sk_, rk_, re_), GitHub (ghp_, github_pat_, gho_), Slack (xox?-),
# Google API keys (AIza), dash-style secret keys (sk-), GitLab (glpat-), AWS access key ids (AKIA).
KEY_PREFIX = re.compile(
    r"(?<![A-Za-z0-9])(?:sk_|rk_|re_|ghp_|gho_|github_pat_|xox[abposr]-|AIza|sk-|glpat-|AKIA)"
    r"[A-Za-z0-9_\-]{8,}"
)
# scheme://user:password@host. A placeholder password (all capitals, <...>, or ***) is a format note.
URL_CREDENTIAL = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*://[^\s/:@]+:([^\s/@]+)@")
PLACEHOLDER = re.compile(r"[A-Z_]+|<[^>]*>|\*+|\.\.\.")
TOKEN_CHARS = re.compile(r"[A-Za-z0-9+/=_\-]{20,}")


def is_secret_name(name: str) -> bool:
    if name in NOT_SECRET_NAMES:
        return False
    return name in SECRET_NAMES or bool(SECRET_NAME.search(name))


def entropy(s: str) -> float:
    """Shannon entropy in bits per character."""
    return -sum((n := s.count(c)) / len(s) * math.log2(n / len(s)) for c in set(s))


def looks_like_credential(text: str, *, value: bool) -> str | None:
    """Why the text looks like a real credential, or None. The entropy rule is for values only:
    comments hold paths and prose that a long-token rule would misread."""
    if m := KEY_PREFIX.search(text):
        return f"provider key prefix {m.group(0)[:6]}..."
    for m in URL_CREDENTIAL.finditer(text):
        if not PLACEHOLDER.fullmatch(m.group(1)):
            return "URL with user:password"
    if value:
        for m in TOKEN_CHARS.finditer(text):
            run = m.group(0)
            if re.search(r"[A-Za-z]", run) and re.search(r"[0-9]", run) and entropy(run) >= 3.5:
                return "long high-entropy string"
    return None


def value_errors(label: str, text: str) -> list[str]:
    """Every value problem in one example file: a secret-named variable with a value, or a value
    or comment shaped like a credential. The message never repeats the value."""
    errors: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            if why := looks_like_credential(stripped, value=False):
                errors.append(f"{label}:{lineno}: comment holds what looks like a credential ({why})")
            continue
        m = re.match(r"([A-Za-z][A-Za-z0-9_]*)=(.*)$", stripped)
        if not m:
            continue
        name, raw = m.group(1), m.group(2).strip()
        val = raw[1:-1] if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'" else raw
        if val and is_secret_name(name):
            errors.append(f"{label}:{lineno}: {name} is a secret and must be empty in an example")
        elif val and (why := looks_like_credential(val, value=True)):
            errors.append(f"{label}:{lineno}: {name} has a value that looks like a credential ({why})")
    return errors


def tracked() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [p for p in out.split("\0") if p and (ROOT / p).is_file()]


def read(path: str | Path) -> str:
    p = ROOT / path if not isinstance(path, Path) else path
    return p.read_text(encoding="utf-8", errors="replace")


def shown(path: Path) -> str:
    """The path as messages print it: relative to the repository when it is inside it."""
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def listed(path: Path) -> set[str]:
    return set(re.findall(r"^([A-Za-z][A-Za-z0-9_]*)=", read(path), flags=re.M))


def settings_fields() -> set[str]:
    tree = ast.parse(read("backend/app/core/config.py"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            return {
                n.target.id
                for n in node.body
                if isinstance(n, ast.AnnAssign)
                and isinstance(n.target, ast.Name)
                and re.fullmatch(NAME, n.target.id)
            }
    raise SystemExit("check_env_example: class Settings not found in backend/app/core/config.py")


def go_names(files: list[str]) -> set[str]:
    names: set[str] = set()
    for f in files:
        if f.startswith("services/realtime/") and f.endswith(".go"):
            text = read(f)
            names |= set(re.findall(rf'\br\.(?:str|integer|duration)\("({NAME})"', text))
            names |= set(re.findall(rf'\bos\.Getenv\("({NAME})"\)', text))
    return names - PLATFORM


def ts_reads(files: list[str], prefix: str) -> set[str]:
    names: set[str] = set()
    for f in files:
        if f.startswith(prefix) and f.endswith(TS_SUFFIXES) and not f.endswith(".d.ts"):
            text = read(f)
            names |= set(re.findall(rf"\bprocess\.env\.({NAME})\b", text))
            names |= set(re.findall(rf"\benv\.({NAME})\b", text))
            names |= set(re.findall(rf'\brequireEnv\("({NAME})"\)', text))
    return names - PLATFORM


def terraform_vars(files: list[str]) -> set[str]:
    return {
        f"TF_VAR_{m}"
        for f in files
        if f.startswith("infra/terraform/") and f.endswith(".tf")
        for m in re.findall(r'^variable\s+"([a-z0-9_]+)"', read(f), flags=re.M)
    }


def shell_inputs(files: list[str]) -> set[str]:
    wanted = [
        f
        for f in files
        if f in {"docker-compose.yml", "scripts/api_check.compose.yml", "infra/bootstrap.sh",
                 "scripts/cost_check.sh", ".circleci/config.yml", ".circleci/rollback.yml"}
        or (f.startswith("scripts/ci/") and f.endswith(".sh") and "test_ci_scripts" not in f)
    ]
    names: set[str] = set()
    for f in wanted:
        names |= set(re.findall(rf"\$\{{({NAME}):[-?]", read(f)))
    return {n for n in names if not n.startswith("CIRCLE_") and n not in PLATFORM}


def main() -> int:
    files = tracked()
    docs = {k: listed(v) for k, v in ENV_FILES.items()}
    errors: list[str] = []

    def need(expected: set[str], where: str, label: str) -> None:
        for n in sorted(expected - docs[where]):
            errors.append(f"{shown(ENV_FILES[where])}: missing {n} ({label})")

    need(settings_fields() | {"PORT"}, "backend", "API Settings / Dockerfile")
    need(go_names(files), "realtime", "services/realtime")
    for app in ("booking", "admin"):
        need(ts_reads(files, f"apps/{app}/"), app, f"apps/{app} reads")
    shared = ts_reads(files, "packages/api/src/")
    for n in sorted(shared - docs["booking"] - docs["admin"]):
        errors.append(f"apps/*/.env.example: no app lists {n} (read in packages/api/src)")

    union = set().union(*(docs[k] for k in ("backend", "realtime", "booking", "admin")))
    need(union | terraform_vars(files) | shell_inputs(files), "root", "component files / Terraform / scripts")

    scan = [
        f for f in files
        if not f.endswith((".env.example", ".lock", ".svg", ".png", ".jpg", ".webp", ".ico", ".md", ".json"))
        and not f.startswith("docs/")
        and "pnpm-lock" not in f
    ]
    blob = "\n".join(read(f) for f in scan if (ROOT / f).stat().st_size < 2_000_000)
    for where, names in docs.items():
        for n in sorted(names):
            probe = n.removeprefix("TF_VAR_")
            if not re.search(rf"(?<![A-Za-z0-9_]){re.escape(probe)}(?![A-Za-z0-9_])", blob):
                errors.append(f"{shown(ENV_FILES[where])}: {n} is not used anywhere (stale)")

    for path in ENV_FILES.values():
        errors.extend(value_errors(shown(path), read(path)))

    if errors:
        print("env example check failed:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    print(f"env example check ok: {sum(len(v) for v in docs.values())} names across {len(docs)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())

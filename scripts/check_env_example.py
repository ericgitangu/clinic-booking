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
  or one of SECRET_NAMES, which also holds the account identifiers the files say to keep empty) must
  be empty.
* No value, and nothing in a comment, may look like a real credential: a known key prefix (sk_, rk_,
  re_, ghp_, xox?-, AIza, ...), a URL with user:password, or a long high-entropy string.
* An assignment is `NAME=value`, `export NAME=value` or `NAME = value`, quoted or not. A line the
  example leaves commented out (`# NAME=`) still counts as listing NAME and gets the same value
  checks: it is how the files keep a variable out of the environment when the file is copied or
  sourced. A name may be listed once.

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
SECRET_NAMES = {
    "DATABASE_URL", "PURGE_DATABASE_URL", "E2E_DB_URL", "GOOGLE_CLIENT_ID",
    # Marked Sensitive in Vercel, or "leave empty here" in the example files.
    "GCP_PROJECT_NUMBER", "GCP_SERVICE_ACCOUNT_EMAIL", "RECAPTCHA_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PROJECT_NUMBER", "DEPLOYER_SA", "TF_VAR_project_number",
    # Account identifiers and personal addresses with no default: the examples take your own values.
    "GOOGLE_PROJECT_ID", "TF_VAR_project_id", "PROJECT", "GCLOUD_ACCOUNT", "BILLING_ACCOUNT",
    "BILLING_GCLOUD_ACCOUNT", "NEON_PROJECT_ID", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID",
    "TF_VAR_circleci_org_id", "TF_VAR_circleci_project_id", "TF_VAR_circleci_gcp_deploy_context_id",
    "TF_VAR_vercel_team", "TF_VAR_alert_email", "ADMIN_EMAILS", "OWNER_EMAILS",
}
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
# scheme://user:password@host. A placeholder password (PASSWORD, <...>, ***, ${VAR}) is a format note.
URL_CREDENTIAL = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*://[^\s/:@]+:([^\s/@]+)@")
PLACEHOLDER = re.compile(
    r"(?:PASSWORD|PASS|PWD|SECRET|TOKEN|KEY|PW|X{3,})|<[^>]*>|\*+|\.\.\.|\$\{?[A-Za-z_]+\}?"
)
# One assignment line. The leading `#` form is a variable the example keeps commented out: it needs
# an upper-case name (or TF_VAR_) so that prose such as "# Note: a=b" is not read as one.
ASSIGN = re.compile(r"^(?P<hash>#\s*)?(?:export\s+)?(?P<name>[A-Za-z][A-Za-z0-9_]*)\s*=\s*(?P<raw>.*)$")
COMMENTED_NAME = re.compile(r"[A-Z][A-Z0-9_]{2,}|TF_VAR_[a-z0-9_]+")
TOKEN_CHARS = re.compile(r"[A-Za-z0-9+/=_\-]{20,}")


def is_secret_name(name: str) -> bool:
    if name in NOT_SECRET_NAMES:
        return False
    return name in SECRET_NAMES or bool(SECRET_NAME.search(name))


def entropy(s: str) -> float:
    """Shannon entropy in bits per character."""
    return -sum((n := s.count(c)) / len(s) * math.log2(n / len(s)) for c in set(s))


def is_identifier_path(run: str) -> bool:
    """A path, file name or variable name quoted in a comment: pieces split on / _ - that are each
    all lower case or all upper case (apps/admin/e2e/global-setup, CIRCLE_OIDC_TOKEN_V2). A random
    key mixes cases or has no separator, so it is not one. Comments only: values stay strict."""
    parts = [p for p in re.split(r"[/_\-]", run) if p]
    return len(parts) > 1 and all(p == p.lower() or p == p.upper() for p in parts)


def looks_like_credential(text: str, *, value: bool) -> str | None:
    """Why the text looks like a real credential, or None. `value` is kept for callers; the entropy
    rule runs on comments too, where a run needs letters and digits and high entropy and must not be
    a path or variable name, so prose and a documented placeholder such as `openssl rand -hex 32`
    do not match."""
    if m := KEY_PREFIX.search(text):
        return f"provider key prefix {m.group(0)[:6]}..."
    for m in URL_CREDENTIAL.finditer(text):
        if not PLACEHOLDER.fullmatch(m.group(1)):
            return "URL with user:password"
    for m in TOKEN_CHARS.finditer(text):
        run = m.group(0)
        if not value and is_identifier_path(run):
            continue
        if re.search(r"[A-Za-z]", run) and re.search(r"[0-9]", run) and entropy(run) >= 3.5:
            return "long high-entropy string"
    return None


def parse_assignment(line: str) -> tuple[str, str, bool] | None:
    """(name, raw value, commented out) for an assignment line, else None."""
    m = ASSIGN.match(line.strip())
    if not m:
        return None
    name, commented = m.group("name"), bool(m.group("hash"))
    if commented and not COMMENTED_NAME.fullmatch(name):
        return None
    return name, m.group("raw").strip(), commented


def value_errors(label: str, text: str) -> list[str]:
    """Every value problem in one example file: a secret-named variable with a value, or a value
    or comment shaped like a credential. The message never repeats the value."""
    errors: list[str] = []
    first_seen: dict[str, int] = {}
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        parsed = parse_assignment(stripped)
        if not parsed:
            if stripped.startswith("#") and (why := looks_like_credential(stripped, value=False)):
                errors.append(f"{label}:{lineno}: comment holds what looks like a credential ({why})")
            continue
        name, raw, _commented = parsed
        if name in first_seen:
            errors.append(f"{label}:{lineno}: {name} is listed twice (first on line {first_seen[name]})")
        else:
            first_seen[name] = lineno
        quoted = len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'"
        if quoted:
            val, trailing = raw[1:-1], ""
        else:
            val, _, trailing = raw.partition(" #")
            val = val.strip()
        if val and is_secret_name(name):
            errors.append(f"{label}:{lineno}: {name} is a secret and must be empty in an example")
        elif val and (why := looks_like_credential(val, value=True)):
            errors.append(f"{label}:{lineno}: {name} has a value that looks like a credential ({why})")
        elif trailing and (why := looks_like_credential(trailing, value=False)):
            errors.append(f"{label}:{lineno}: comment holds what looks like a credential ({why})")
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
    names = (parse_assignment(line) for line in read(path).splitlines())
    return {p[0] for p in names if p}


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

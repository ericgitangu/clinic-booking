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

Platform-set names (NODE_ENV, VERCEL, VERCEL_ENV, CI, CIRCLECI) and names CircleCI supplies (CIRCLE_*) are
documented in comments, not as assignments, so they are exempt.
"""

from __future__ import annotations

import ast
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
            errors.append(f"{ENV_FILES[where].relative_to(ROOT)}: missing {n} ({label})")

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
                errors.append(f"{ENV_FILES[where].relative_to(ROOT)}: {n} is not used anywhere (stale)")

    if errors:
        print("env example check failed:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    print(f"env example check ok: {sum(len(v) for v in docs.values())} names across {len(docs)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
#
# One-off removal of the release smoke's old test rows (patients named 'verify-claims %' and
# 'Release Gate Check%', their appointments and events) from the database. See purge_synthetic.sql
# for exactly what is selected and deleted.
#
#   PURGE_DATABASE_URL=... purge_synthetic.sh            dry run: counts only, in a READ ONLY, rolled-back transaction
#   PURGE_DATABASE_URL=... purge_synthetic.sh --apply    delete in ONE transaction as the owner role,
#                                                        print before/after counts, roll back on any mismatch
#
# The connection string comes from the environment only (never argv, never a file, never echoed): it
# must be the OWNER role's, because the runtime role has no DELETE. Accepted forms: a libpq URL, or
# the migrate secret's SQLAlchemy form (postgresql+asyncpg://...?ssl=require), which is converted.
# Production, with the owner DSN supplied for this one command only:
#
#   PURGE_DATABASE_URL="$(gcloud secrets versions access latest --secret clinic-database-url-migrate \
#       --project sil-clinic-booking --account "$GCLOUD_ACCOUNT")" bash scripts/ops/purge_synthetic.sh
#
# Always dry-run first, read the counts, then re-run with --apply.
# Exit codes: 0 done, 1 psql failed (nothing was committed), 2 refused (bad usage).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY=0

die() { echo "purge_synthetic: $*" >&2; exit "${2:-2}"; }

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

command -v psql >/dev/null || die "psql not found" 1
[ -n "${PURGE_DATABASE_URL:-}" ] || die "set PURGE_DATABASE_URL (the owner role's connection string) in the environment"
command -v python3 >/dev/null || die "python3 not found" 1

export PGCONNECT_TIMEOUT=20
if [ "$APPLY" = 1 ]; then echo "purge_synthetic: APPLY mode" >&2; else echo "purge_synthetic: dry run (use --apply to delete)" >&2; fi

# psql takes a URL only as an argument, and an argument shows in `ps`. So split the URL into the
# libpq environment variables (the password included) and exec psql with no secret on its command
# line. -I: no user site or current-directory imports. --no-psqlrc: the run must not depend on the
# operator's psql settings.
exec python3 -I -c '
import os, sys
from urllib.parse import parse_qs, unquote, urlsplit

raw = os.environ.pop("PURGE_DATABASE_URL").replace("postgresql+asyncpg:", "postgresql:", 1)
u = urlsplit(raw)
if u.scheme not in ("postgresql", "postgres") or not u.hostname or not u.username:
    sys.exit("purge_synthetic: PURGE_DATABASE_URL is not a postgresql://user@host/db URL")
q = parse_qs(u.query)
ssl = (q.get("sslmode") or q.get("ssl") or ["require"])[0]
env = dict(os.environ, PGHOST=u.hostname, PGUSER=unquote(u.username),
           PGDATABASE=unquote(u.path.lstrip("/")), PGSSLMODE=ssl)
if u.port:
    env["PGPORT"] = str(u.port)
if u.password:
    env["PGPASSWORD"] = unquote(u.password)
os.execvpe("psql", ["psql", "--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1",
                    "-v", "apply=" + sys.argv[2], "-f", sys.argv[1]], env)
' "$HERE/purge_synthetic.sql" "$APPLY"

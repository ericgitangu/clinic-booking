# Runbook: Neon (Postgres)

Free project, `aws-us-east-1` (beside Cloud Run `us-east4`), PG 17, no card. By the engineer.
This is step 6 of `docs/runbooks/bootstrap-gcp.md`; its shell variables (`PROJECT`,
`GCLOUD_ACCOUNT`) apply here too.

## Create

1. `neonctl projects create --help` first: the flags are unverified; adjust to the output.
2. Create the project in `aws-us-east-1` on PG 17, database `clinic`, owner role
   `clinic_owner`. Set compute to a fixed 0.25 CU (autoscaling min = max = 0.25); leave
   scale-to-zero on (it cannot be disabled on Free). No card.
3. Note the **direct** host (the one without `-pooler` in its name) and `clinic_owner`'s
   password from the console or `neonctl connection-string`:

   ```bash
   export NEON_HOST=ep-xxxxxxxx.us-east-1.aws.neon.tech # direct host, NOT -pooler
   export OWNER_PW=<clinic_owner password from Neon>
   ```

## Two different URL forms

Do not mix them up; they are used by different programs.

| Used by | Form |
|---|---|
| `psql` (this runbook, libpq) | `postgresql://clinic_owner:$OWNER_PW@$NEON_HOST/clinic?sslmode=require` |
| the application and Alembic (the two secrets) | `postgresql+asyncpg://USER:PASS@$NEON_HOST/clinic?ssl=require` |

The application builds its engine with `create_async_engine`, so the secret **must** start
with `postgresql+asyncpg://`. Neon hands out `postgresql://...?sslmode=require`; pasting that
into a secret fails on the first migrate with `ModuleNotFoundError` (it selects the psycopg
driver). The app also rejects `sslmode` and `channel_binding` in the query, because asyncpg
does not accept them; use `ssl=require` only.

## Runtime role

Create it in SQL as `clinic_owner` (not in the console, so it does not inherit
`neon_superuser`). The password is hex so it never needs URL-escaping. Feed the SQL on
**stdin**: psql does not interpolate `:'pw'` inside a `-c` string (tested: `-c` gives a
syntax error, stdin works).

```bash
export APP_PW=$(openssl rand -hex 24) # never echo it
psql "postgresql://clinic_owner:${OWNER_PW}@${NEON_HOST}/clinic?sslmode=require" \
  -v ON_ERROR_STOP=1 -v pw="$APP_PW" <<'SQL'
CREATE ROLE clinic_app LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
SQL
```

Acceptance: connected as `clinic_app`, `CREATE TABLE x(i int)` is `permission denied`.

## Record (into ADR-0003 and ADR-0014)

```sql
SHOW max_connections;
SELECT name FROM pg_available_extensions WHERE name = 'btree_gist';
```

## Secret versions (the containers already exist from Terraform)

```bash
APP_URL="postgresql+asyncpg://clinic_app:${APP_PW}@${NEON_HOST}/clinic?ssl=require"
MIGRATE_URL="postgresql+asyncpg://clinic_owner:${OWNER_PW}@${NEON_HOST}/clinic?ssl=require"

printf %s "$APP_URL" | gcloud secrets versions add clinic-database-url-app --data-file=- \
  --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
printf %s "$MIGRATE_URL" | gcloud secrets versions add clinic-database-url-migrate --data-file=- \
  --account "$GCLOUD_ACCOUNT" --project "$PROJECT"

unset APP_PW OWNER_PW APP_URL MIGRATE_URL
gcloud secrets versions list clinic-database-url-app --account "$GCLOUD_ACCOUNT" \
  --project "$PROJECT" --format=json | jq length # 1
```

If `OWNER_PW` contains characters that are special in URLs, percent-encode it in
`MIGRATE_URL`.

## Rotation

Disabled secret versions still count toward the 6-version cap and are billed past it, so
rotate by adding, redeploying, then **destroying** the old version:

```bash
gcloud secrets versions destroy <old> --secret=<secret> \
  --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
```

## Optional realtime feature: `clinic_realtime`

Only if the realtime gateway ships. As `clinic_owner`, before its migration is merged:

```bash
export RT_PW=$(openssl rand -hex 24)
psql "postgresql://clinic_owner:${OWNER_PW}@${NEON_HOST}/clinic?sslmode=require" \
  -v ON_ERROR_STOP=1 -v pw="$RT_PW" <<'SQL'
CREATE ROLE clinic_realtime LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE clinic_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE clinic_realtime SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE clinic_owner SET idle_in_transaction_session_timeout = '5min';
SQL
```

Apply the two `GRANT`s from the event-cursor migration idempotently, and confirm
`SHOW max_prepared_transactions` is `0`; record it in the PR description.

# Runbook: Neon (Postgres)

Free project, `aws-us-east-1` (beside Cloud Run us-east4), PG 17, no card. By the engineer.

## Create

1. `neonctl projects create --help` first — the flags are unverified; adjust to the output.
2. Create the project in `aws-us-east-1` on PG 17, database `clinic`, owner role
   `clinic_owner`. Set compute to a fixed 0.25 CU (autoscaling min = max = 0.25); leave
   scale-to-zero on (cannot be disabled on Free). No card.

## Runtime role (SQL, as clinic_owner — not via the console, so it does not inherit neon_superuser)

```sql
CREATE ROLE clinic_app LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
```
Password from `openssl rand -base64 32`; never echoed. Acceptance: as `clinic_app`,
`CREATE TABLE x(i int)` → permission denied.

## Record (into ADR-0003 / ADR-0014)

```sql
SHOW max_connections;
SELECT name FROM pg_available_extensions WHERE name = 'btree_gist';
```

## Secret versions (containers already exist from Terraform)

Use the **direct (non-pooler) host** and `?ssl=require` only (no sslmode/channel_binding —
the app config validator rejects those):
```bash
printf %s "$APP_URL"     | gcloud secrets versions add clinic-database-url-app     --data-file=- --project "$PROJECT"
printf %s "$MIGRATE_URL" | gcloud secrets versions add clinic-database-url-migrate --data-file=- --project "$PROJECT"
```

## Rotation ($0: never leave a disabled version — disabled still counts toward the 6-version cap)

```bash
# add new version, redeploy, then DESTROY the old one:
gcloud secrets versions destroy <old> --secret=<secret> --project "$PROJECT"
```

## STRETCH S1 (only if WP-S1a ships): clinic_realtime

As `clinic_owner`, before WP-S1a merges:
```sql
CREATE ROLE clinic_realtime LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- apply the two GRANTs from migration 0003 idempotently (no-ops if 0003 already granted them)
ALTER ROLE clinic_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE clinic_realtime SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE clinic_owner SET idle_in_transaction_session_timeout = '5min';
```
Confirm `SHOW max_prepared_transactions` → `0` and record it in `docs/versions.md`.

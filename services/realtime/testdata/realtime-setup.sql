-- TEST SETUP ONLY. A stand-in for what lane L1 ships (alembic 0003_event_cursor and the
-- clinic_realtime role of docs/adr/0015). testenv applies it only when appointment_events has no
-- txid column yet; once L1's migration is on main the column exists and this file is not run, so
-- the privilege tests then check L1's real grants instead of ours.
-- Run by the database owner (the compose superuser), idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'clinic_realtime') THEN
    CREATE ROLE clinic_realtime LOGIN PASSWORD 'clinic_realtime_local'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER TABLE appointment_events
  ADD COLUMN IF NOT EXISTS txid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX IF NOT EXISTS ix_events_txid_id ON appointment_events (txid, id);

GRANT USAGE ON SCHEMA public TO clinic_realtime;
GRANT SELECT (id, txid, doctor_id, event_type, from_starts_at, to_starts_at, local_date,
              from_local_date, occurred_at)
  ON appointment_events TO clinic_realtime;
ALTER ROLE clinic_realtime SET idle_in_transaction_session_timeout = '30s';

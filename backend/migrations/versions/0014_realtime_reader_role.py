"""the live-feed gateway's database role: SELECT on a handful of columns, nothing else

Revision ID: 0014
Revises: 0008
Create Date: 2026-10-19

Pins the privileges of ``clinic_realtime``, the login the Go gateway (``services/realtime``) uses to
stream the admin live feed. Expand-only and idempotent: it creates no table and changes no column.

The role itself is created outside the migration, like ``clinic_app`` (``docker/initdb`` locally
and in CI, ``docs/runbooks/neon.md`` on Neon). Unlike migration 0001 this one does not fail when the
role is missing: it raises a NOTICE and grants nothing, because ``ship-api`` runs
``alembic upgrade head`` on every merge and the optional gateway must never block an API release.
The runbook step re-applies the same grants (``scripts/ops/realtime_grants.sql``), so a skipped
grant is recoverable without a new migration. ``tests/integration/test_realtime_role.py`` asserts
the result with a real login.

What the role may read, and why:

- ``appointment_events``: the log being streamed, including ``txid`` for the commit-safe cursor;
  ``appointment_id`` only so the staff shape can link to the appointment and join its patient.
- ``appointments (id, patient_id, status, cancellation_reason)`` and ``patients (id, full_name,
  synthetic)``: the staff shape (owner, admin) carries the patient's name and a cancellation reason;
  a viewer's stream never selects them. ``synthetic`` hides the release smoke's own rows.
- ``staff_access (email, role, revoked_at)``: the gateway re-checks the role in the signed assertion
  against the database, exactly as the API does, and again while the stream is open.

Nothing else: no other column (not the patient's email or phone), no other table, no write, no
sequence, no DDL, no default privileges, and ``idle_in_transaction_session_timeout`` of 30 s so an
abandoned transaction cannot hold the stream horizon back.
"""

from __future__ import annotations

from alembic import op

revision = "0014"
# Chained onto main's head at rebase time (0008). If the open migrations 0009/0010 merge first,
# this is re-pointed onto the new head; ``alembic heads | wc -l`` must stay 1.
down_revision = "0008"
branch_labels = None
depends_on = None

GRANTS = """
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM clinic_realtime;
    GRANT USAGE ON SCHEMA public TO clinic_realtime;
    GRANT SELECT (id, txid, appointment_id, doctor_id, event_type, from_starts_at, to_starts_at,
                  local_date, from_local_date, occurred_at)
      ON appointment_events TO clinic_realtime;
    GRANT SELECT (id, patient_id, status, cancellation_reason) ON appointments TO clinic_realtime;
    GRANT SELECT (id, full_name, synthetic) ON patients TO clinic_realtime;
    GRANT SELECT (email, role, revoked_at) ON staff_access TO clinic_realtime;
    ALTER ROLE clinic_realtime SET idle_in_transaction_session_timeout = '30s';
"""


def upgrade() -> None:
    op.execute(f"""
        DO $$
        BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'clinic_realtime') THEN
            {GRANTS}
          ELSE
            RAISE NOTICE 'role clinic_realtime missing: no grants made (docs/runbooks/neon.md)';
          END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'clinic_realtime') THEN
            REVOKE ALL ON ALL TABLES IN SCHEMA public FROM clinic_realtime;
            REVOKE USAGE ON SCHEMA public FROM clinic_realtime;
          END IF;
        END $$;
    """)

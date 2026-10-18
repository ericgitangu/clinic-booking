"""the live-feed gateway: a stream position on the staff audit trail, and its read-only role

Revision ID: 0014
Revises: 0010
Create Date: 2026-10-19

Two parts, both expand-only.

1. ``staff_action_audit`` joins the stream. Staff actions that leave no lifecycle event (a
   reminder sent now, "running late", invitations) are streamed from the audit trail itself, so each
   row needs a commit-safe position in the same order as ``appointment_events``:

   - ``txid xid8 DEFAULT pg_current_xact_id()``: the writing transaction, as on appointment_events
     (migration 0006), so the gateway's horizon rule (``txid < pg_snapshot_xmin``) covers both.
   - ``stream_id bigint DEFAULT nextval(<appointment_events.id sequence>)``: drawn from the event
     log's own sequence, so an audit row and an event never share an id and the stream keeps ONE
     cursor, ``<txid>.<id>``, over both tables. The API never names either column; the defaults fill
     them. ``clinic_app`` already holds USAGE on that sequence (migration 0001).

   The action list is widened with ``invite_accept`` (accepting an invitation is now audited like
   creating and revoking one). Same superset-CHECK pattern as migration 0010.

2. The privileges of ``clinic_realtime``, the login the Go gateway (``services/realtime``) uses.
   The role itself is created outside the migration, like ``clinic_app`` (``docker/initdb`` locally
   and in CI, ``docs/runbooks/neon.md`` on Neon). Unlike migration 0001 this does not fail when the
   role is missing: it raises a NOTICE and grants nothing, because ``ship-api`` runs
   ``alembic upgrade head`` on every merge and the optional gateway must never block an API release.
   The runbook step re-applies the same grants (``scripts/ops/realtime_grants.sql``), so a skipped
   grant is recoverable without a new migration. ``tests/integration/test_realtime_role.py`` asserts
   the result with a real login.

What the role may read, and why:

- ``appointment_events``: the log being streamed, ``txid`` for the commit-safe cursor, ``actor`` to
  know a staff change; ``appointment_id`` only so the staff shape can link and join its patient.
- ``appointments (id, patient_id, doctor_id, starts_at, status, cancellation_reason,
  predecessor_id)`` and ``patients (id, full_name, synthetic)``: the staff shape (owner, admin)
  carries the patient's name and a cancellation reason. ``doctor_id`` and ``starts_at`` place a
  reminder or "running late" row; ``predecessor_id`` lets a page opened on a cancelled appointment
  hear that a veto re-booked it. ``synthetic`` hides the release smoke's own rows.
- ``staff_action_audit (stream_id, txid, actor_email, actor_role, action, appointment_id, reason,
  after, occurred_at)``: who did a staff action and why. ``after`` holds ids, outcomes and a hash of
  an invited address, never an address (the API's own rule for the audit trail).
- ``staff_invites (id, email, role)``: the invited address, for the owner/admin shape only.
- ``staff_access (email, role, revoked_at)``: the gateway re-checks the role in the signed assertion
  against the database, exactly as the API does, and again while the stream is open.

PII minimisation for viewers is enforced in the gateway, not by these grants: the role CAN read the
patient's name, the reasons and the invited address, and the viewer's query simply never selects
them (``services/realtime/internal/store``; a Go test fails if the viewer query names any of those
columns). A second, viewer-only role would move that guarantee into the database; it is recorded as
accepted debt in the hosting and cost analysis (/decisions#hosting-and-cost).

Nothing else: no other column (not the patient's email or phone), no other table, no write, no
sequence, no DDL, no default privileges, and ``idle_in_transaction_session_timeout`` of 30 s so an
abandoned transaction cannot hold the stream horizon back.
"""

from __future__ import annotations

from alembic import op

revision = "0014"
# Chained onto main's head at rebase time (0010, after the staff migrations). A migration that
# lands first re-points this onto the new head; ``alembic heads | wc -l`` must stay 1.
down_revision = "0010"
branch_labels = None
depends_on = None

GRANTS = """
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM clinic_realtime;
    GRANT USAGE ON SCHEMA public TO clinic_realtime;
    GRANT SELECT (id, txid, appointment_id, doctor_id, event_type, from_starts_at, to_starts_at,
                  local_date, from_local_date, occurred_at, actor)
      ON appointment_events TO clinic_realtime;
    GRANT SELECT (id, patient_id, doctor_id, starts_at, status, cancellation_reason, predecessor_id)
      ON appointments TO clinic_realtime;
    GRANT SELECT (id, full_name, synthetic) ON patients TO clinic_realtime;
    GRANT SELECT (stream_id, txid, actor_email, actor_role, action, appointment_id, reason, after,
                  occurred_at)
      ON staff_action_audit TO clinic_realtime;
    GRANT SELECT (id, email, role) ON staff_invites TO clinic_realtime;
    GRANT SELECT (email, role, revoked_at) ON staff_access TO clinic_realtime;
    ALTER ROLE clinic_realtime SET idle_in_transaction_session_timeout = '30s';
"""


def upgrade() -> None:
    # The event log's identity sequence, resolved once so the default is a plain nextval.
    op.execute("""
        DO $$
        BEGIN
          EXECUTE format(
            'ALTER TABLE staff_action_audit
               ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
               ADD COLUMN stream_id bigint NOT NULL DEFAULT nextval(%L::regclass)',
            pg_get_serial_sequence('appointment_events', 'id'));
        END $$;
    """)
    op.execute(
        "CREATE UNIQUE INDEX uq_staff_action_audit_stream ON staff_action_audit (txid, stream_id);"
    )
    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")  # noqa: E501  # contract-ok: widened below
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke', 'invite_accept',
                          'arrived', 'no_show', 'reminder_now', 'running_late'));
    """)
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
    # An accepted invitation is a record the older action list cannot hold: refuse while one exists.
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM staff_action_audit WHERE action = 'invite_accept') THEN
            RAISE EXCEPTION 'refusing to downgrade 0014: invite_accept audit rows would go'
              USING ERRCODE = 'P0001';
          END IF;
        END $$;
    """)
    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke',
                          'arrived', 'no_show', 'reminder_now', 'running_late'));
    """)
    op.execute("DROP INDEX IF EXISTS uq_staff_action_audit_stream;")
    op.execute(
        "ALTER TABLE staff_action_audit"
        " DROP COLUMN IF EXISTS stream_id, DROP COLUMN IF EXISTS txid;"
    )
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'clinic_realtime') THEN
            REVOKE ALL ON ALL TABLES IN SCHEMA public FROM clinic_realtime;
            REVOKE USAGE ON SCHEMA public FROM clinic_realtime;
          END IF;
        END $$;
    """)

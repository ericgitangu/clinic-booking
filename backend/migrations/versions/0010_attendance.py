"""attendance: who arrived and who did not turn up

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-18

Expand-only: one new append-only table, and the staff audit trail's list of actions widened to
name the new ones. ``appointment_attendance`` takes INSERT and SELECT for the runtime role and
nothing else; the current state of an appointment is its latest row, so a correction is a new row
(and an audit row with a reason), never an edit.

The widening replaces the CHECK on ``staff_action_audit.action`` with a superset. No existing row
can violate it and the previous API revision only writes values both lists contain, so it is safe
against the new schema; the line is marked for the migration lint for that reason.
"""

from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE appointment_attendance (
          id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          appointment_id  uuid NOT NULL REFERENCES appointments(id),
          kind            text NOT NULL CHECK (kind IN ('arrived', 'no_show')),
          marked_by       text NOT NULL,
          marked_at       timestamptz NOT NULL DEFAULT now()
        );
    """)
    op.execute(
        "CREATE INDEX ix_attendance_appointment "
        "ON appointment_attendance (appointment_id, id DESC);"
    )
    op.execute("CREATE INDEX ix_attendance_marked_at ON appointment_attendance (marked_at);")
    op.execute("REVOKE ALL ON appointment_attendance FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT ON appointment_attendance TO clinic_app;")
    # Accepting an invite is attempt-limited per person per UTC day, counted whether or not the
    # attempt succeeds. The key is a hash, never the address.
    op.execute("""
        CREATE TABLE invite_accept_cap (
          actor_key  text PRIMARY KEY,
          day        date NOT NULL,
          n          integer NOT NULL CHECK (n >= 0)
        );
    """)
    op.execute("GRANT SELECT, INSERT, UPDATE ON invite_accept_cap TO clinic_app;")
    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")  # noqa: E501  # contract-ok: widened below
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke',
                          'arrived', 'no_show', 'reminder_now', 'running_late'));
    """)
    # Staff annotations on the event stream (the live admin feed shows them): same widening, same
    # reasoning. The patient channel ignores them.
    widen = "ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_event_type_check;"  # noqa: E501  # contract-ok: widened below
    op.execute(widen)
    op.execute("""
        ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_event_type_check
        CHECK (event_type IN ('booked', 'cancelled', 'rescheduled',
                              'vetoed', 'unlocked', 'arrived', 'no_show'));
    """)


def downgrade() -> None:
    # The audit trail and the attendance marks are append-only records. Going back would have to
    # delete them (the older schema cannot hold their action names or their table), so it refuses
    # while any exist instead of destroying data. Restore from a backup, or export and remove the
    # rows deliberately as the owner, before downgrading.
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM staff_action_audit
                     WHERE action IN ('arrived', 'no_show', 'reminder_now', 'running_late'))
             OR EXISTS (SELECT 1 FROM appointment_attendance)
             OR EXISTS (SELECT 1 FROM appointment_events
                        WHERE event_type IN ('vetoed', 'unlocked', 'arrived', 'no_show')) THEN
            RAISE EXCEPTION 'refusing to downgrade 0010: audit, attendance or event rows would go'
              USING ERRCODE = 'P0001';
          END IF;
        END $$;
    """)
    op.execute("DROP TABLE IF EXISTS invite_accept_cap;")
    op.execute(
        "ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_event_type_check;"
    )
    op.execute("""
        ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_event_type_check
        CHECK (event_type IN ('booked', 'cancelled', 'rescheduled'));
    """)
    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke'));
    """)
    op.execute("DROP TABLE IF EXISTS appointment_attendance;")

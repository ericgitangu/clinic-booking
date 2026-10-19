"""staff appointment actions, the lock, the staff audit trail and email invites

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-18

Expand-only: four nullable columns, two new tables, one trigger. Nothing existing is dropped,
narrowed or rewritten, and the previous API revision never names the new columns, so it keeps
working against the new schema.

``appointments.staff_locked_at`` is the veto lock; a reschedule updates the same row, so the lock
follows it. Undoing a cancel books a NEW appointment, so ``appointments.predecessor_id`` links it to
the cancelled one and the lock is set on the new row. ``appointment_events.actor`` says who made a
change ('patient' or 'staff'; NULL on rows written before this migration).

``staff_action_audit`` is append-only for the runtime role: SELECT and INSERT, plus UPDATE on the
single column ``notified`` (the patient email goes out after the response, so the flag can only be
set afterwards) and a trigger that lets it move from false to true and never back, and only on a
row whose action emails the patient and whose outcome was not recorded as not sent. Any other
UPDATE, and every DELETE, is refused by privilege. The row id is the idempotency key of the
patient email.

``staff_invites`` stores only the SHA-256 of the 32-byte token: the raw token exists in the email
link alone. The partial unique index allows one open invite per email; re-inviting revokes the
earlier open one in the same transaction.
"""

from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE appointments
          ADD COLUMN staff_locked_at timestamptz NULL,
          ADD COLUMN predecessor_id  uuid NULL REFERENCES appointments(id);
    """)
    op.execute("""
        CREATE INDEX ix_appointments_predecessor ON appointments (predecessor_id)
        WHERE predecessor_id IS NOT NULL;
    """)
    op.execute("""
        ALTER TABLE appointment_events
          ADD COLUMN actor text NULL CHECK (actor IN ('patient', 'staff'));
    """)

    op.execute("""
        CREATE TABLE staff_action_audit (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          actor_email     text NOT NULL,
          actor_role      staff_role NOT NULL,
          action          text NOT NULL
                          CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                                    'invite_create', 'invite_revoke')),
          appointment_id  uuid NULL REFERENCES appointments(id),
          reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
          before          jsonb NOT NULL DEFAULT '{}'::jsonb,
          after           jsonb NOT NULL DEFAULT '{}'::jsonb,
          notified        boolean NOT NULL DEFAULT false,
          -- clock_timestamp, not now(): rows written in one transaction keep their order
          occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp()
        );
    """)
    op.execute(
        "CREATE INDEX ix_staff_action_audit_time ON staff_action_audit (occurred_at DESC, id DESC);"
    )
    op.execute("CREATE INDEX ix_staff_action_audit_appt ON staff_action_audit (appointment_id);")
    op.execute("REVOKE ALL ON staff_action_audit FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT ON staff_action_audit TO clinic_app;")
    op.execute("GRANT UPDATE (notified) ON staff_action_audit TO clinic_app;")
    op.execute("""
        CREATE FUNCTION staff_action_audit_notified_once() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.notified AND NOT NEW.notified THEN
            RAISE EXCEPTION 'staff_action_audit.notified cannot be unset'
              USING ERRCODE = '42501';
          END IF;
          -- The flag means "the patient was emailed". It can only be set on an action that emails
          -- the patient, and never on a row recorded as not sent (a demo recipient, no address).
          IF NEW.notified AND NOT OLD.notified AND (
               OLD.action NOT IN ('book', 'reschedule', 'cancel', 'veto', 'invite_create',
                                  'reminder_now', 'running_late')
               OR (OLD.after ->> 'outcome') IN ('demo, not sent', 'no email on file')
             ) THEN
            RAISE EXCEPTION 'staff_action_audit.notified cannot be set on this row'
              USING ERRCODE = '42501';
          END IF;
          -- Only the person who made the action may say its patient was told. The API sets
          -- app.actor (transaction-local) to the caller; any other writer has none to show.
          IF NEW.notified AND NOT OLD.notified
             AND COALESCE(current_setting('app.actor', true), '') <> OLD.actor_email THEN
            RAISE EXCEPTION 'staff_action_audit.notified can only be set by the actor'
              USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END $$;
    """)
    op.execute("""
        CREATE TRIGGER trg_staff_action_audit_notified
        BEFORE UPDATE ON staff_action_audit
        FOR EACH ROW EXECUTE FUNCTION staff_action_audit_notified_once();
    """)

    op.execute("""
        CREATE TABLE staff_invites (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email       citext NOT NULL,
          role        staff_role NOT NULL CHECK (role IN ('admin', 'viewer')),
          token_hash  text NOT NULL,
          invited_by  text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          expires_at  timestamptz NOT NULL,
          consumed_at timestamptz NULL,
          revoked_at  timestamptz NULL,
          revoked_by  text NULL,
          CONSTRAINT uq_staff_invites_token UNIQUE (token_hash),
          CONSTRAINT ck_staff_invites_lower CHECK (email::text = lower(email::text)),
          CONSTRAINT ck_staff_invites_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
          CONSTRAINT ck_staff_invites_window CHECK (expires_at > created_at),
          CONSTRAINT ck_staff_invites_one_end CHECK (consumed_at IS NULL OR revoked_at IS NULL)
        );
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_staff_invites_open ON staff_invites (email)
        WHERE consumed_at IS NULL AND revoked_at IS NULL;
    """)
    op.execute(
        "CREATE INDEX ix_staff_invites_invited_by ON staff_invites (invited_by, created_at);"
    )
    op.execute("REVOKE ALL ON staff_invites FROM clinic_app;")
    # Only the three columns an invite's life changes: superseding or revoking, and consuming. The
    # address, role, token hash, inviter and times are fixed once written.
    op.execute("GRANT SELECT, INSERT ON staff_invites TO clinic_app;")
    op.execute("GRANT UPDATE (consumed_at, revoked_at, revoked_by) ON staff_invites TO clinic_app;")


def downgrade() -> None:
    # The audit trail and the invitations are records. The older schema has nowhere to keep them,
    # so going back would delete them; it refuses while either holds a row. Export or remove the
    # rows deliberately, as the owner, before downgrading.
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM staff_action_audit) OR EXISTS (SELECT 1 FROM staff_invites) THEN
            RAISE EXCEPTION 'refusing to downgrade 0009: audit or invitation rows would go'
              USING ERRCODE = 'P0001';
          END IF;
        END $$;
    """)
    op.execute("DROP TABLE IF EXISTS staff_invites;")
    op.execute("DROP TRIGGER IF EXISTS trg_staff_action_audit_notified ON staff_action_audit;")
    op.execute("DROP FUNCTION IF EXISTS staff_action_audit_notified_once();")
    op.execute("DROP TABLE IF EXISTS staff_action_audit;")
    op.execute("ALTER TABLE appointment_events DROP COLUMN IF EXISTS actor;")
    op.execute("DROP INDEX IF EXISTS ix_appointments_predecessor;")
    op.execute("""
        ALTER TABLE appointments
          DROP COLUMN IF EXISTS predecessor_id,
          DROP COLUMN IF EXISTS staff_locked_at;
    """)

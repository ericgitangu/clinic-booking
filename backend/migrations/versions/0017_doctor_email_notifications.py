"""doctor email and the record of telling a doctor a patient arrived

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-20

Expand-only. Three additions and no backfill:

* ``doctors.email``: nullable, one spelling (lower case, no spaces, one ``@``). A doctor has none
  until staff set one, so a seeded doctor is never emailed. Writing it is a staff action and is
  audited, so ``staff_action_audit.action`` takes one more name (the CHECK is replaced with a
  superset; no existing row can violate it and the previous API revision only writes names both
  lists contain).
* ``doctor_notification``: one row per (appointment, kind), written in the transaction of the
  arrival it is about. ``status`` is pending (to be sent), sent, failed (the provider refused, it
  may be tried again) or skipped; ``reason`` says why a row was skipped and is queryable
  (``no_email``, ``allowance_day``, ``allowance_month``, ``demo_address``, ``not_configured``).
  ``leased_at`` is the claim a sender holds while it sends, as the reminders do. The runtime role
  may read, insert and update; nothing deletes.
"""

from __future__ import annotations

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE doctors ADD COLUMN email text NULL;")
    op.execute("""
        ALTER TABLE doctors ADD CONSTRAINT ck_doctors_email CHECK (
          email IS NULL OR (
            email = lower(email)
            AND length(email) BETWEEN 6 AND 254
            AND email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
          )
        );
    """)

    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")  # noqa: E501  # contract-ok: widened below
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke',
                          'arrived', 'no_show', 'reminder_now', 'running_late',
                          'doctor_email'));
    """)

    op.execute("""
        CREATE TABLE doctor_notification (
          id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          appointment_id uuid NOT NULL REFERENCES appointments(id),
          doctor_id      uuid NOT NULL REFERENCES doctors(id),
          kind           text NOT NULL CHECK (kind IN ('patient_arrived')),
          status         text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
          reason         text NULL CHECK (reason IN (
                           'no_email', 'allowance_day', 'allowance_month',
                           'demo_address', 'not_configured')),
          attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          leased_at      timestamptz NULL,
          sent_at        timestamptz NULL,
          provider_id    text NULL,
          last_error     text NULL CHECK (length(last_error) <= 300),
          created_at     timestamptz NOT NULL DEFAULT now(),
          updated_at     timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_doctor_notification UNIQUE (appointment_id, kind),
          CONSTRAINT ck_doctor_notification_sent CHECK (
            (status = 'sent') = (sent_at IS NOT NULL)
          ),
          CONSTRAINT ck_doctor_notification_skipped CHECK (
            (status = 'skipped') = (reason IS NOT NULL)
          )
        );
    """)
    op.execute(
        "CREATE INDEX ix_doctor_notification_open ON doctor_notification (status, leased_at);"
    )
    op.execute("REVOKE ALL ON doctor_notification FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT, UPDATE ON doctor_notification TO clinic_app;")


def downgrade() -> None:
    # The notification record and the audit rows that name a doctor's email are history. Going back
    # would have to delete them, so it refuses while any exist (restore from a backup, or export
    # and remove them deliberately as the owner, before downgrading).
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM doctor_notification)
             OR EXISTS (SELECT 1 FROM staff_action_audit WHERE action = 'doctor_email') THEN
            RAISE EXCEPTION 'refusing to downgrade 0017: notification or audit rows would go'
              USING ERRCODE = 'P0001';
          END IF;
        END $$;
    """)
    op.execute("DROP TABLE IF EXISTS doctor_notification;")
    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke',
                          'arrived', 'no_show', 'reminder_now', 'running_late'));
    """)
    op.execute("ALTER TABLE doctors DROP CONSTRAINT IF EXISTS ck_doctors_email;")
    op.execute("ALTER TABLE doctors DROP COLUMN IF EXISTS email;")

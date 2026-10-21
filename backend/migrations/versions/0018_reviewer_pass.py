"""reviewer passes

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-21

Expand-only. Two new tables and three more audit action names, no backfill.

* ``staff_passes``: a link the owner makes that any verified Google account can use to get a staff
  role, for at most ``max_uses`` people and until ``expires_at``. Like ``staff_invites`` it keeps
  only the SHA-256 of the 32-byte token. The role is ``admin`` or ``viewer``, never the owner. The
  runtime role may read and insert, and update only ``revoked_at`` and ``revoked_by``: the role,
  the limit, the token hash and the times are fixed once written.
* ``staff_pass_uses``: one row per (pass, address) that took a seat, written in the transaction of
  the grant. Insert and read only, so a seat is never given back.
* ``staff_action_audit.action`` takes ``pass_create``, ``pass_revoke`` and ``pass_accept``. The
  CHECK is replaced with the list 0017 left plus those three; a test compares the database's list
  with ``StaffActionName`` so a later migration that drops a name fails CI.
"""

from __future__ import annotations

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE staff_passes (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          token_hash  text NOT NULL,
          role        staff_role NOT NULL CHECK (role IN ('admin', 'viewer')),
          max_uses    integer NOT NULL CHECK (max_uses BETWEEN 1 AND 10),
          created_by  text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          expires_at  timestamptz NOT NULL,
          revoked_at  timestamptz NULL,
          revoked_by  text NULL,
          CONSTRAINT uq_staff_passes_token UNIQUE (token_hash),
          CONSTRAINT ck_staff_passes_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
          CONSTRAINT ck_staff_passes_window CHECK (expires_at > created_at),
          CONSTRAINT ck_staff_passes_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
        );
    """)
    op.execute("CREATE INDEX ix_staff_passes_created_by ON staff_passes (created_by, created_at);")
    op.execute("""
        CREATE TABLE staff_pass_uses (
          pass_id uuid NOT NULL REFERENCES staff_passes(id),
          email   citext NOT NULL,
          used_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (pass_id, email),
          CONSTRAINT ck_staff_pass_uses_lower CHECK (email::text = lower(email::text))
        );
    """)
    op.execute("REVOKE ALL ON staff_passes FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT ON staff_passes TO clinic_app;")
    op.execute("GRANT UPDATE (revoked_at, revoked_by) ON staff_passes TO clinic_app;")
    op.execute("REVOKE ALL ON staff_pass_uses FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT ON staff_pass_uses TO clinic_app;")

    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")  # noqa: E501  # contract-ok: widened below
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke', 'invite_accept',
                          'arrived', 'no_show', 'reminder_now', 'running_late',
                          'doctor_email',
                          'pass_create', 'pass_revoke', 'pass_accept'));
    """)


def downgrade() -> None:
    # Passes, their uses and the audit rows about them are records. Going back would have to delete
    # them, so it refuses while any exist (export or remove them deliberately, as the owner,
    # before downgrading).
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM staff_passes)
             OR EXISTS (SELECT 1 FROM staff_action_audit WHERE action IN
                 ('pass_create', 'pass_revoke', 'pass_accept')) THEN
            RAISE EXCEPTION 'refusing to downgrade 0018: pass or audit rows would go'
              USING ERRCODE = 'P0001';
          END IF;
        END $$;
    """)
    op.execute("DROP TABLE IF EXISTS staff_pass_uses;")
    op.execute("DROP TABLE IF EXISTS staff_passes;")
    op.execute("ALTER TABLE staff_action_audit DROP CONSTRAINT staff_action_audit_action_check;")
    op.execute("""
        ALTER TABLE staff_action_audit ADD CONSTRAINT staff_action_audit_action_check
        CHECK (action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock',
                          'invite_create', 'invite_revoke', 'invite_accept',
                          'arrived', 'no_show', 'reminder_now', 'running_late',
                          'doctor_email'));
    """)

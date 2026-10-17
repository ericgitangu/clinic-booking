"""email reminders: who has been reminded, and how many emails went out today

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-18

Expand-only: two nullable columns on ``appointments`` and one new table.

``reminder_claimed_at`` is a lease: a run claims an appointment by setting it, and a claim older
than fifteen minutes can be taken again. ``reminder_sent_at`` is set only after the email provider
has accepted the message, and only then is the appointment never reminded again. Rescheduling
clears both, so the new time gets its own reminder.

``email_counter`` counts the emails the provider accepted, per UTC day, so the free plan's daily
limit is shared by acknowledgements and reminders.
"""

from __future__ import annotations

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE appointments
          ADD COLUMN reminder_claimed_at timestamptz NULL,
          ADD COLUMN reminder_sent_at    timestamptz NULL;
    """)
    op.execute("""
        CREATE INDEX ix_appointments_reminder_due ON appointments (starts_at)
        WHERE status = 'booked' AND reminder_sent_at IS NULL;
    """)
    op.execute("""
        CREATE TABLE email_counter (
          day   date PRIMARY KEY,
          sent  integer NOT NULL DEFAULT 0 CHECK (sent >= 0)
        );
    """)
    op.execute("GRANT SELECT, INSERT, UPDATE ON email_counter TO clinic_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS email_counter;")
    op.execute("DROP INDEX IF EXISTS ix_appointments_reminder_due;")
    op.execute("""
        ALTER TABLE appointments
          DROP COLUMN IF EXISTS reminder_sent_at,
          DROP COLUMN IF EXISTS reminder_claimed_at;
    """)

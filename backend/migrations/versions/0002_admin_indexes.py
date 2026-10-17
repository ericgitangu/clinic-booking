"""indexes for the admin dashboard queries

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-17

Expand-only: three indexes, nothing dropped or altered. They keep the dashboard queries flat as
appointments and events accumulate: the activity series filters events by ``occurred_at``, the
lineage reads one appointment's events in id order, and the list and load queries page and
filter appointments by ``starts_at``.

Plain ``CREATE INDEX`` takes a short write lock. That is acceptable at this table size (a few
rows); a large table would need ``CREATE INDEX CONCURRENTLY`` outside the transaction.
"""

from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_events_occurred_at ON appointment_events (occurred_at);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_events_appointment_id "
        "ON appointment_events (appointment_id, id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_appointments_starts_at "
        "ON appointments (starts_at DESC, id DESC);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_appointments_starts_at;")
    op.execute("DROP INDEX IF EXISTS ix_events_appointment_id;")
    op.execute("DROP INDEX IF EXISTS ix_events_occurred_at;")

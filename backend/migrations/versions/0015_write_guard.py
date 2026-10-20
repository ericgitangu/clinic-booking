"""staff write guard: per-actor write throttle and a replay store for signed assertions

Revision ID: 0015
Revises: 0013
Create Date: 2026-10-19

Expand-only: two new tables.

``staff_write_throttle`` holds one row per person (a SHA-256 of the normalised email, never the
address) with the fixed window they are in and how many staff writes they have made in it. The
window and the count move in place, so nothing is ever deleted.

``assertion_replay`` holds the SHA-256 of the MAC of each signed assertion that was used on a write
until it can no longer be valid (a minute and a few seconds). The primary key makes "first use
wins" atomic across instances; expired rows are deleted in small batches by the writes themselves,
which is why the runtime role gets DELETE (and, for the locking read, UPDATE on one column) on this
one table.
"""

from __future__ import annotations

from alembic import op

revision = "0015"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE staff_write_throttle (
          actor_key  text PRIMARY KEY,
          window_id  bigint NOT NULL,
          n          integer NOT NULL CHECK (n >= 0)
        );
    """)
    op.execute("REVOKE ALL ON staff_write_throttle FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT, UPDATE ON staff_write_throttle TO clinic_app;")
    op.execute("""
        CREATE TABLE assertion_replay (
          replay_key  text PRIMARY KEY CHECK (replay_key ~ '^[0-9a-f]{64}$'),
          expires_at  timestamptz NOT NULL
        );
    """)
    op.execute("CREATE INDEX ix_assertion_replay_expires ON assertion_replay (expires_at);")
    op.execute("REVOKE ALL ON assertion_replay FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT, DELETE ON assertion_replay TO clinic_app;")
    # SELECT ... FOR UPDATE SKIP LOCKED (the clean-up) needs some UPDATE privilege; one column is
    # enough and nothing is ever updated.
    op.execute("GRANT UPDATE (expires_at) ON assertion_replay TO clinic_app;")


def downgrade() -> None:
    # Both tables are working state, not records: the throttle's counters and the replay keys of
    # assertions that expire within a minute. Dropping them loses nothing that matters.
    op.execute("DROP TABLE IF EXISTS assertion_replay;")
    op.execute("DROP TABLE IF EXISTS staff_write_throttle;")

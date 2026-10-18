"""synthetic patients: mark the release smoke's own rows so the dashboard can leave them out

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-18

Expand-only: one column with a constant default on ``patients``. Nothing existing is dropped,
altered or rewritten (a constant default is metadata only on Postgres 11+), and every existing row
reads ``false``. The previous API revision never names the column, so it keeps working against
the new schema; the runtime role's table-level SELECT, INSERT and UPDATE already cover it.

The release pipeline books and cancels real rows in the production database on every release
(``scripts/verify_claims.py``). Those rows are marked ``synthetic = true`` so the admin metrics,
chart, utilisation, list and realtime admin feed can exclude them. The flag is set only by the
internal smoke endpoint, which is signed with its own key; the public API cannot set it.
"""

from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE patients ADD COLUMN synthetic boolean NOT NULL DEFAULT false;")


def downgrade() -> None:
    op.execute("ALTER TABLE patients DROP COLUMN IF EXISTS synthetic;")

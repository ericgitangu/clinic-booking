"""the clinic is called Idyllic Clinic: rename the seeded clinic's name where it is stored

Revision ID: 0011
Revises: 0014
Create Date: 2026-10-19

A data migration, no schema change: ``clinics.name`` is the only column that holds the clinic's
name, and doctor cards read it. Every row whose name contains the old name has that part replaced;
a row that does not contain it is not touched, and a second run finds nothing to change. The
release's seed step already writes the new name for the seeded clinic, so this makes the rename
part of the schema history as well, for a database that is upgraded without a seed.

The downgrade does nothing: a name is not reverted to one the product no longer uses.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0014"
branch_labels = None
depends_on = None

OLD_NAME = "Mvule Family Clinic"
NEW_NAME = "Idyllic Clinic"


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE clinics SET name = replace(name, :old, :new) WHERE position(:old in name) > 0"
        ),
        {"old": OLD_NAME, "new": NEW_NAME},
    )


def downgrade() -> None:
    pass

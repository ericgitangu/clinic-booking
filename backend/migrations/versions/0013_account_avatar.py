"""patient accounts: the Google profile picture URL, for the admin app

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-18

Expand-only: one nullable column and a column-level UPDATE grant.

``image_url`` is the picture URL Google gives at sign-in. The API only ever stores a URL on
``https://lh3.googleusercontent.com/`` (the check below is the last line of defence; the boundary
in ``app.domain.avatar`` is the first). The runtime role could only insert into this table; it now
may also update this one column, so the URL follows the person's current picture on every sign-in
and is cleared when they have none. Nothing else in the row can be changed.
"""

from __future__ import annotations

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE patient_accounts
          ADD COLUMN image_url text NULL,
          ADD CONSTRAINT ck_patient_accounts_image_url CHECK (
            image_url IS NULL
            OR (length(image_url) <= 2048
                AND image_url LIKE 'https://lh3.googleusercontent.com/%')
          );
    """)
    op.execute("GRANT UPDATE (image_url) ON patient_accounts TO clinic_app;")


def downgrade() -> None:
    op.execute("REVOKE UPDATE (image_url) ON patient_accounts FROM clinic_app;")
    op.execute("ALTER TABLE patient_accounts DROP COLUMN IF EXISTS image_url;")

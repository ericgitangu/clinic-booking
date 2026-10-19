"""demo patients, and mark the release smoke's older rows as synthetic

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-18

Expand-only: one column with a constant default on ``patients`` and one idempotent data step.

``patients.demo`` marks the curated, fictional demo patients that ``python -m
app.scripts.seed_demo`` creates. They are ordinary rows for every query, including the admin
views (unlike ``synthetic``, which the admin views leave out); the flag only says "this person is
invented", so a reviewer can tell and a later clean-up can find them. Nothing in the API sets it.

The data steps mark every patient the release smoke and the manual release checks created before
the synthetic flag (0008) existed (names ``verify-claims %`` and ``Release Gate Check%``) as
``synthetic``, so their appointments drop out of every admin metric, chart, list and utilisation
figure. It deletes nothing. A patient linked to a sign-in account is never touched, whatever name
they typed. It is idempotent: a second run matches nothing new (``AND NOT synthetic``).
"""

from __future__ import annotations

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


# Kept as a constant so the test can run the very same statement a second time.
BACKFILL_SYNTHETIC = """
    UPDATE patients p SET synthetic = true
    WHERE NOT p.synthetic
      AND (p.full_name LIKE 'verify-claims %' OR p.full_name LIKE 'Release Gate Check%')
      AND NOT EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.id)
"""


# The two patients the pre-submission audit created in production ("Brief Audit Probe", with four
# appointments, all cancelled again). Matched by exact id AND exact name, never by name alone.
BACKFILL_AUDIT_PROBES = """
    UPDATE patients p SET synthetic = true
    WHERE NOT p.synthetic
      AND p.id IN ('0850abfb-2261-4774-a4f0-edef28683612',
                   '9e5e4aa0-cdda-4a4b-ab70-ed07c8d420f3')
      AND p.full_name = 'Brief Audit Probe'
      AND NOT EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.id)
"""


def upgrade() -> None:
    op.execute("ALTER TABLE patients ADD COLUMN demo boolean NOT NULL DEFAULT false;")
    op.execute(BACKFILL_SYNTHETIC)
    op.execute(BACKFILL_AUDIT_PROBES)


def downgrade() -> None:
    # The backfilled synthetic flags are left as they are: 0008 owns that column.
    op.execute("ALTER TABLE patients DROP COLUMN IF EXISTS demo;")

"""mark the smoke patients that 0012 missed as synthetic

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-20

Data only, no schema change: idempotent ``UPDATE patients SET synthetic = true``, never a delete.

The release's public smoke ran ``scripts/verify_claims.py`` without the signing key, so it created
ordinary patients (named ``verify-claims <timestamp> <n>``) after 0012 had backfilled the older
ones. It now runs read-only. This marks the ones it already left behind, and the one manual
release check from 2026-10-17 that used the public ``POST /patients`` (``Gate Reviewer``, with an
``gate<digits>@example.com`` address, created that clinic-local day). A patient linked to a sign-in
account is never touched, whatever name they typed. A second run matches nothing
(``NOT synthetic``).
"""

from __future__ import annotations

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


# Kept as constants so the test can run the very same statements a second time.
MARK_SMOKE_PATIENTS = """
    UPDATE patients p SET synthetic = true
    WHERE NOT p.synthetic
      AND p.full_name LIKE 'verify-claims %'
      AND NOT EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.id)
"""

MARK_GATE_REVIEWER = """
    UPDATE patients p SET synthetic = true
    WHERE NOT p.synthetic
      AND p.full_name = 'Gate Reviewer'
      AND p.email ~ '^gate[0-9]+@example\\.com$'
      AND (p.created_at AT TIME ZONE 'Africa/Nairobi')::date = DATE '2026-10-17'
      AND NOT EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.id)
"""


def upgrade() -> None:
    op.execute(MARK_SMOKE_PATIENTS)
    op.execute(MARK_GATE_REVIEWER)


def downgrade() -> None:
    # The flags are left as they are: 0008 owns the column and nothing says which rows were ours.
    pass

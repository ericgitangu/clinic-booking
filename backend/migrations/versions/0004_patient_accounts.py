"""patient accounts: which sign-in belongs to which patient

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-18

Expand-only: one new table, nothing existing is touched.

``google_sub`` is the stable id the sign-in provider gives a person. A patient is created for it
the first time it links, and the row is what lets the web app answer "which appointments are
mine" without ever trusting a patient id from the browser. A patient has at most one account. The
runtime role can insert and read, never update or delete.
"""

from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE patient_accounts (
          google_sub  text PRIMARY KEY,
          patient_id  uuid NOT NULL REFERENCES patients (id),
          email       text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_patient_accounts_patient UNIQUE (patient_id)
        );
    """)
    op.execute("REVOKE ALL ON patient_accounts FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT ON patient_accounts TO clinic_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS patient_accounts;")

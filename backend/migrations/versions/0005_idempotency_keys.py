"""idempotency key and request fingerprint on appointments

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-18

Expand-only: two nullable columns, two checks and one partial unique index. Nothing existing is
touched, and every existing row keeps both columns NULL.

The key lives on the appointment row, so no separate table, no stored
response and no expiry job: a key lives exactly as long as its booking. That is why the runtime
role needs no new privilege. The table-level SELECT, INSERT and UPDATE it already holds cover the
new columns, and there is still no DELETE anywhere.
"""

from __future__ import annotations

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE appointments ADD COLUMN idempotency_key text NULL;")
    op.execute("ALTER TABLE appointments ADD COLUMN request_fingerprint text NULL;")
    # 1-255 visible ASCII characters (0x21-0x7E), the same rule the API applies to the header.
    op.execute(r"""
        ALTER TABLE appointments ADD CONSTRAINT ck_appt_idempotency_key
          CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[\x21-\x7e]{1,255}$');
    """)
    # A key without its fingerprint (or the reverse) could never be checked on replay.
    op.execute("""
        ALTER TABLE appointments ADD CONSTRAINT ck_appt_idempotency_pair
          CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL));
    """)
    op.execute(
        "CREATE UNIQUE INDEX uq_appt_patient_idempotency_key "
        "ON appointments (patient_id, idempotency_key) WHERE idempotency_key IS NOT NULL;"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_appt_patient_idempotency_key;")
    op.execute("ALTER TABLE appointments DROP CONSTRAINT IF EXISTS ck_appt_idempotency_pair;")
    op.execute("ALTER TABLE appointments DROP CONSTRAINT IF EXISTS ck_appt_idempotency_key;")
    op.execute("ALTER TABLE appointments DROP COLUMN IF EXISTS request_fingerprint;")
    op.execute("ALTER TABLE appointments DROP COLUMN IF EXISTS idempotency_key;")

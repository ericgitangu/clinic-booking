"""staff access: who may use the admin app, and what they may do

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-17

Expand-only: one extension, one enum, two new tables. Nothing existing is touched.

``staff_access`` holds the people the owner has let in (the owner themselves comes from
configuration and has no row). A revoke sets ``revoked_at`` and keeps the row, so the history
survives and nothing is ever deleted. ``staff_access_audit`` gets one row per grant, change and
revoke.

``CREATE EXTENSION citext`` needs a role that may create extensions. On Neon the project owner
can; on a locked-down server a superuser must run it once before this migration.
"""

from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext;")
    op.execute("CREATE TYPE staff_role AS ENUM ('owner', 'admin', 'viewer');")
    op.execute("""
        CREATE TABLE staff_access (
          id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          email       citext NOT NULL,
          role        staff_role NOT NULL,
          granted_by  text NOT NULL,
          granted_at  timestamptz NOT NULL DEFAULT now(),
          revoked_at  timestamptz NULL,
          CONSTRAINT uq_staff_access_email UNIQUE (email),
          CONSTRAINT ck_staff_access_lower CHECK (email::text = lower(email::text))
        );
    """)
    op.execute("""
        CREATE TABLE staff_access_audit (
          id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          actor_email  text NOT NULL,
          action       text NOT NULL CHECK (action IN ('grant', 'change', 'revoke')),
          target_email text NOT NULL,
          old_role     staff_role NULL,
          new_role     staff_role NULL,
          occurred_at  timestamptz NOT NULL DEFAULT now()
        );
    """)
    op.execute("CREATE INDEX ix_staff_audit_occurred_at ON staff_access_audit (occurred_at DESC);")
    # The runtime role can never delete. The audit trail is append-only for it: the default
    # privileges from the first migration would also give it UPDATE on the new table, so they are
    # withdrawn and only SELECT and INSERT are granted back.
    op.execute("GRANT SELECT, INSERT, UPDATE ON staff_access TO clinic_app;")
    op.execute("REVOKE ALL ON staff_access_audit FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT ON staff_access_audit TO clinic_app;")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clinic_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS staff_access_audit;")
    op.execute("DROP TABLE IF EXISTS staff_access;")
    op.execute("DROP TYPE IF EXISTS staff_role;")

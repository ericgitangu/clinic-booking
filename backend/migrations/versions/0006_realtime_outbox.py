"""realtime outbox: commit-safe event order, relay cursor, publish budget, token cap

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-18

Expand-only: one column with a default, one index and three small tables. Nothing is dropped or
altered. The runtime role gains no DELETE and no DDL, and loses UPDATE on the event log.

``appointment_events.txid`` is the transaction that wrote the event (``pg_current_xact_id()``,
filled by the column default inside the booking transaction, so no insert code changes). A
sequence value alone cannot order events for a reader: transaction A can take a lower id, B a
higher one, and B can commit first, so a reader that remembers the highest id seen would skip A
for ever. The relay reads ``(txid, id)`` pairs only below the snapshot's ``xmin`` (every
transaction older than that has finished), which makes the order safe. Existing rows get the
migration's own txid, which is below every later horizon.

``event_relay_cursor`` is a single row: the last event handed to the push service
(``txid``, ``id``) and the last event whose publishes were already counted against the monthly
budget (``debited_txid``, ``debited_id``), so retrying the same events during an outage is free.
Both start at "everything that exists now": ``ADD COLUMN`` gave every existing row the
migration's own transaction id, so the seed is that transaction id with the highest existing row
id, and the first relay run sends only events written after the upgrade, not the history.

``realtime_publish_budget`` holds one row per calendar month (the hard cap on publishes, enforced
by the API, not by the push service).
``realtime_token_cap`` keeps one row per client address (IPv6 by /64) with the day and its count;
the day resets in place, so no row is ever deleted and the role needs no DELETE.
"""

from __future__ import annotations

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE appointment_events ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();"
    )
    op.execute("CREATE INDEX ix_events_txid_id ON appointment_events (txid, id);")

    op.execute("""
        CREATE TABLE event_relay_cursor (
          singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          txid         xid8   NOT NULL,
          id           bigint NOT NULL,
          debited_txid xid8   NOT NULL,
          debited_id   bigint NOT NULL,
          updated_at   timestamptz NOT NULL DEFAULT now()
        );
    """)
    op.execute("""
        INSERT INTO event_relay_cursor (txid, id, debited_txid, debited_id)
        SELECT pg_current_xact_id(), m.max_id, pg_current_xact_id(), m.max_id
        FROM (SELECT coalesce(max(id), 0) AS max_id FROM appointment_events) AS m;
    """)
    # The log is append-only: nothing updates an event, and its (txid, id) is the ordering the relay
    # trusts, so the runtime role must not be able to rewrite it.
    op.execute("REVOKE UPDATE ON appointment_events FROM clinic_app;")
    op.execute("REVOKE ALL ON event_relay_cursor FROM clinic_app;")
    op.execute("GRANT SELECT, UPDATE ON event_relay_cursor TO clinic_app;")

    op.execute("""
        CREATE TABLE realtime_publish_budget (
          month      date PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
          used       integer NOT NULL DEFAULT 0 CHECK (used >= 0),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
    """)
    op.execute("REVOKE ALL ON realtime_publish_budget FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT, UPDATE ON realtime_publish_budget TO clinic_app;")

    op.execute("""
        CREATE TABLE realtime_token_cap (
          ip_key text PRIMARY KEY CHECK (length(ip_key) BETWEEN 1 AND 64),
          day    date    NOT NULL,
          n      integer NOT NULL CHECK (n >= 0)
        );
    """)
    op.execute("REVOKE ALL ON realtime_token_cap FROM clinic_app;")
    op.execute("GRANT SELECT, INSERT, UPDATE ON realtime_token_cap TO clinic_app;")


def downgrade() -> None:
    op.execute("GRANT UPDATE ON appointment_events TO clinic_app;")
    op.execute("DROP TABLE IF EXISTS realtime_token_cap;")
    op.execute("DROP TABLE IF EXISTS realtime_publish_budget;")
    op.execute("DROP TABLE IF EXISTS event_relay_cursor;")
    op.execute("DROP INDEX IF EXISTS ix_events_txid_id;")
    op.execute("ALTER TABLE appointment_events DROP COLUMN IF EXISTS txid;")

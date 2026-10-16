#!/usr/bin/env bash
# Enforce expand-only migrations (ADR-0015): the upgrade() body must not drop or narrow
# anything. Destructive ops are allowed only on a line carrying "# contract-ok", and the
# downgrade() body is not scanned (reversing an expand is expected to drop).
set -euo pipefail

VERSIONS_DIR="backend/migrations/versions"
# Case-insensitive; catches both raw SQL (op.execute) and the Alembic Python API
# (op.drop_table/op.drop_column/op.drop_constraint/op.drop_index/op.alter_column/op.rename_*),
# plus TRUNCATE/DELETE. grep -iE is applied below.
DESTRUCTIVE='drop table|drop column|drop constraint|drop index|alter column|drop not null|drop default|\brename\b|truncate|\bdelete\b|op\.drop_|op\.alter_column|op\.rename_'

status=0
shopt -s nullglob
for f in "$VERSIONS_DIR"/*.py; do
  # Extract the upgrade() body: lines from `def upgrade` up to the next `def `.
  upgrade_body="$(awk '
    /^def upgrade\(/ {inb=1; next}
    /^def / {inb=0}
    inb {print}
  ' "$f")"

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if printf '%s\n' "$line" | grep -iEq "$DESTRUCTIVE"; then
      if printf '%s\n' "$line" | grep -q '# contract-ok'; then
        continue
      fi
      echo "migration-lint: destructive op in upgrade() of $f:"
      echo "  $line"
      status=1
    fi
  done <<< "$upgrade_body"
done

if [ "$status" -eq 0 ]; then
  echo "migration-lint: all migrations are expand-only."
fi
exit "$status"

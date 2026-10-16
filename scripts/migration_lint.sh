#!/usr/bin/env bash
# Enforce expand-only migrations: the upgrade() body must not drop or narrow
# anything. Destructive ops are allowed only on a line carrying "# contract-ok", and the
# downgrade() body is not scanned (reversing an expand is expected to drop).
set -euo pipefail

VERSIONS_DIR="backend/migrations/versions"
# Case-insensitive; catches both raw SQL (op.execute) and the Alembic Python API
# (op.drop_table/op.drop_column/op.drop_constraint/op.drop_index/op.alter_column/op.rename_*),
# plus TRUNCATE/DELETE. grep -iE is applied below.
DESTRUCTIVE='drop table|drop column|drop constraint|drop index|drop (type|view|function|trigger|schema|extension|sequence)|alter column|drop not null|drop default|\brename\b|truncate|\bdelete[[:space:]]+from\b|op\.drop_|op\.alter_column|op\.rename_'

# Limits: only the body of upgrade() is scanned, line by line. A destructive statement built in a
# helper function, assembled across lines, or hidden in a string that is concatenated at runtime
# is not seen; review such a migration by hand. The bare word "delete" is deliberately NOT a
# match (comments and names would trip it); only "delete from" is.
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

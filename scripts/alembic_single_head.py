#!/usr/bin/env python3
"""Fail unless the migration chain has exactly one head.

Two branches that each add "the next" migration produce two heads; Alembic then refuses to
upgrade, in production. This reads the revision files directly (no database, no Alembic import),
so it runs anywhere and can be pointed at a fixture directory.

    python3 scripts/alembic_single_head.py [versions_dir]
"""

from __future__ import annotations

import pathlib
import re
import sys

DEFAULT = "backend/migrations/versions"
REVISION = re.compile(r'^revision\s*(?::\s*[^=]+)?=\s*["\']([^"\']+)["\']', re.MULTILINE)
DOWN = re.compile(r"^down_revision\s*(?::\s*[^=]+)?=\s*(.+)$", re.MULTILINE)


def heads(directory: pathlib.Path) -> tuple[list[str], list[str]]:
    """(heads, problems) of the revision files in ``directory``."""
    revisions: dict[str, pathlib.Path] = {}
    parents: set[str] = set()
    problems: list[str] = []
    for path in sorted(directory.glob("*.py")):
        text = path.read_text()
        rev = REVISION.search(text)
        down = DOWN.search(text)
        if rev is None or down is None:
            problems.append(f"{path.name}: no revision or down_revision found")
            continue
        if rev.group(1) in revisions:
            problems.append(f"{path.name}: revision {rev.group(1)} also used by {revisions[rev.group(1)].name}")
        revisions[rev.group(1)] = path
        parents.update(re.findall(r'["\']([^"\']+)["\']', down.group(1)))
    return sorted(r for r in revisions if r not in parents), problems


def main(argv: list[str]) -> int:
    directory = pathlib.Path(argv[1] if len(argv) > 1 else DEFAULT)
    found, problems = heads(directory)
    for line in problems:
        print(f"alembic-heads: {line}")
    if problems or len(found) != 1:
        print(f"alembic-heads: expected exactly one head, found {len(found)}: {', '.join(found)}")
        print("alembic-heads: renumber so the migrations form one chain, then retry.")
        return 1
    print(f"alembic-heads: one head ({found[0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

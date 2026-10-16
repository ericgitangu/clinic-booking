"""Seed stub (WP-03). WP-04 replaces this with the real idempotent seed.

Running it before the schema exists is a safe no-op.
"""

from __future__ import annotations


async def main() -> None:
    return None


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())

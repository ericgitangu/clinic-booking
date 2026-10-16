"""Export the OpenAPI contract to contracts/openapi.json.

Builds the app with FIXED settings, independent of the environment, and never connects to
the database (the engine is lazy). Writes sorted keys so the output is byte-stable.
"""

from __future__ import annotations

import json
import os
import pathlib

# app.main builds a module-level app from the environment (for the uvicorn CMD). Give it a
# value so this env-independent export imports cleanly; the contract is built from
# FIXED_SETTINGS below, so `make openapi` and `DATABASE_URL=bogus make openapi` are identical.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x@localhost/x")

from app.core.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "contracts" / "openapi.json"

FIXED_SETTINGS = Settings(
    PUBLIC_BASE_URL="https://api.example",
    WEB_ORIGIN="http://localhost:3000",
    DATABASE_URL="postgresql+asyncpg://x@localhost/x",
)


def main() -> None:
    app = create_app(FIXED_SETTINGS)
    spec = app.openapi()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()

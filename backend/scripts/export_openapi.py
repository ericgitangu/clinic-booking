"""Export the OpenAPI contract to contracts/openapi.json.

Builds the app with FIXED settings, independent of the environment, and never connects to
the database (the engine is lazy). Writes sorted keys so the output is byte-stable.
"""

from __future__ import annotations

import json
import pathlib

from app.core.config import Settings
from app.main import create_app

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

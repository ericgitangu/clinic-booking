"""One way to write an email address for comparison and storage.

NFKC folds compatibility characters (fullwidth letters, ligatures) to their plain forms, then
casefold lowercases the way Unicode defines it. Used at invite creation, at accept and for the
role lookup, so two spellings of one address are never two people.
"""

from __future__ import annotations

import unicodedata


def normalize_email(value: str) -> str:
    # casefold alone is not stable under lower() for every script (Cherokee folds to capitals),
    # and the database compares with lower(); folding then lowering gives what both agree on.
    return unicodedata.normalize("NFKC", value).strip().casefold().lower()

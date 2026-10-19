from __future__ import annotations

import pytest

from app.services.admin import mask_phone


@pytest.mark.parametrize(
    ("phone", "masked"),
    [
        ("+254712345678", "+**********78"),
        ("+14155552671", "+*********71"),
        ("0712345678", "********78"),
        ("+2547123", "+*****23"),
        ("+25471", "+*****"),
        ("0712", "****"),
        ("", ""),
        (None, None),
    ],
)
def test_only_the_last_two_digits_survive(phone: str | None, masked: str | None) -> None:
    assert mask_phone(phone) == masked
    if phone and masked:
        assert len(masked) == len(phone)

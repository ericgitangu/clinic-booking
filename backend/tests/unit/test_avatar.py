"""Only https URLs on lh3.googleusercontent.com are kept as a patient's picture."""

from __future__ import annotations

import pytest

from app.domain.avatar import safe_google_image

GOOD = "https://lh3.googleusercontent.com/a/ACg8ocJxyz=s96-c"


def test_a_google_picture_url_is_kept() -> None:
    assert safe_google_image(GOOD) == GOOD


@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        "http://lh3.googleusercontent.com/a/x",  # not https
        "https://lh3.googleusercontent.com.evil.com/a/x",  # lookalike host
        "https://evil.com/lh3.googleusercontent.com/a/x",
        "https://lh3.googleusercontent.com@evil.com/a/x",  # credentials trick
        "https://evil.com@lh3.googleusercontent.com/a/x",  # credentials, even to the right host
        "https://lh3.googleusercontent.com:8443/a/x",  # explicit port
        "https://LH3.googleusercontent.com.evil.com/a/x",
        "https://lh4.googleusercontent.com/a/x",
        "https://googleusercontent.com/a/x",
        "//lh3.googleusercontent.com/a/x",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "https://lh3.googleusercontent.com/a/x y",  # whitespace
        "https://lh3.googleusercontent.com/a/x\n",
        "https://lh3.googleusercontent.com",  # no path
        "https://lh3.googleusercontent.com/" + "a" * 2100,  # too long
    ],
)
def test_anything_else_is_dropped(url: str | None) -> None:
    assert safe_google_image(url) is None

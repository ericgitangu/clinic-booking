"""Which picture URLs the API will keep. Pure: no I/O.

A Google profile picture is shown to owners and admins in the admin app, so what is stored must be
a URL on Google's own picture host and nothing else. Anything that is not exactly that is dropped
(stored as null) without an error: the caller learns nothing about why, and a hostile value is
never echoed or logged.
"""

from __future__ import annotations

from urllib.parse import urlsplit

HOST = "lh3.googleusercontent.com"
MAX_LENGTH = 2048


def safe_google_image(url: str | None) -> str | None:
    """The URL when it is ``https://lh3.googleusercontent.com/...``, otherwise ``None``.

    Exact host match on the parsed URL (so ``lh3.googleusercontent.com.evil.com`` and
    ``lh3.googleusercontent.com@evil.com`` fail), https only, no credentials in the URL, no
    explicit port, no whitespace or control characters, and a bounded length.
    """
    if not url or len(url) > MAX_LENGTH or any(c.isspace() or ord(c) < 0x20 for c in url):
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or parts.hostname != HOST:
        return None
    if parts.username is not None or parts.password is not None or port is not None:
        return None
    if not url.startswith(f"https://{HOST}/"):
        return None
    return url

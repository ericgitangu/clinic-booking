"""Who may actually be emailed. Pure."""

from __future__ import annotations

from typing import Literal

Outcome = Literal["to send", "demo, not sent", "no email on file"]

# Names that can never reach a person (RFC 2606 and 6761): the three example domains and the
# reserved top-level names test, example, invalid and localhost. An address matches when its domain
# is one of them or ends in ".<one of them>", ignoring case and a trailing dot. A message to one is
# recorded as "demo, not sent" and the email provider is never called. The admin app's sender keeps
# the same list; contracts/demo-recipients.json is the shared test fixture.
DEMO_NAMES = (
    "example.com",
    "example.net",
    "example.org",
    "example",
    "test",
    "invalid",
    "localhost",
)


def is_demo_recipient(email: str) -> bool:
    domain = email.strip().lower().rpartition("@")[2].rstrip(".")
    if not domain:
        return False
    return any(domain == n or domain.endswith(f".{n}") for n in DEMO_NAMES)


def outcome_for(email: str | None) -> Outcome:
    if email is None or not email.strip():
        return "no email on file"
    return "demo, not sent" if is_demo_recipient(email) else "to send"

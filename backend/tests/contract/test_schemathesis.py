"""Property-based contract tests: Schemathesis drives every operation in the committed spec
and asserts status-code conformance, response-schema conformance and no server errors.
Any 5xx is a bug to fix, never a relaxed check.
"""

from __future__ import annotations

from typing import Any

import schemathesis
from hypothesis import settings
from schemathesis.checks import (
    not_a_server_error,
    response_schema_conformance,
    status_code_conformance,
)

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from app.services.publisher import DisabledPublisher
from tests.conftest import FIXED_NOW, make_settings
from tests.integration.realtime_support import TEST_KEY

# A key is configured so the realtime token route is in its working state: with push switched off
# it answers 503 by design, and this suite treats every 5xx as a bug. (A throwaway key; it is only
# used to sign tokens, nothing here reaches the push service.)
_app = create_app(make_settings(ABLY_API_KEY=TEST_KEY))
# Nothing in this suite may reach the network: tokens are signed locally, and publishing is off.
_app.state.publisher = DisabledPublisher()
_app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)

schema = schemathesis.openapi.from_asgi("/openapi.json", _app)

CHECKS = [not_a_server_error, status_code_conformance, response_schema_conformance]


@schema.parametrize()
@settings(max_examples=25, deadline=None)
def test_api(case: schemathesis.Case[Any]) -> None:
    case.call_and_validate(checks=CHECKS)

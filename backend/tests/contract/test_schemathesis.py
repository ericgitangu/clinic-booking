"""Property-based contract tests: Schemathesis drives every operation in the committed spec
and asserts status-code conformance, response-schema conformance and no server errors.
Any 5xx is a bug to fix, never a relaxed check.
"""

from __future__ import annotations

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
from tests.conftest import FIXED_NOW, make_settings

_app = create_app(make_settings())
_app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)

schema = schemathesis.openapi.from_asgi("/openapi.json", _app)

CHECKS = (not_a_server_error, status_code_conformance, response_schema_conformance)


@schema.parametrize()
@settings(max_examples=25, deadline=None)
def test_api(case: schemathesis.Case) -> None:
    case.call_and_validate(checks=CHECKS)

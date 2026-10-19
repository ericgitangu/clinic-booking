"""The shared assertion vectors: the Python verifier must reach the verdict recorded for each case.

``contracts/assertion-vectors.json`` is read by the Go gateway's tests too; a regenerated file must
equal the committed one, so neither side can change the scheme alone.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from app.core.assertion import InvalidAssertion, verify
from scripts.make_assertion_vectors import OUT, build

DOC: dict[str, Any] = json.loads(OUT.read_text(encoding="utf-8"))


def test_committed_vectors_are_current() -> None:
    assert json.loads(json.dumps(build(), sort_keys=True)) == DOC


def _verify(case: dict[str, Any]) -> Any:
    return verify(
        str(case["header"]),
        key=DOC["key"].encode(),
        method=str(case["method"]),
        path_with_query=str(case["path"]),
        body=str(case["body"]).encode(),
        now=datetime.fromtimestamp(int(case["now"]), tz=UTC),
    )


@pytest.mark.parametrize("case", DOC["cases"], ids=lambda c: str(c["name"]))
def test_python_reaches_the_recorded_verdict(case: dict[str, Any]) -> None:
    if case["expect"] == "ok":
        principal = _verify(case)
        assert {
            "sub": principal.sub,
            "email": principal.email,
            "role": principal.role,
            "email_verified": principal.email_verified,
        } == case["principal"]
    else:
        with pytest.raises(InvalidAssertion, match=str(case["expect"])):
            _verify(case)

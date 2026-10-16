from __future__ import annotations

from typing import Any, cast

import pytest

from app.schemas.problem import strip_json_from_error_responses


def test_malformed_paths_raises_type_error() -> None:
    with pytest.raises(TypeError, match="paths"):
        strip_json_from_error_responses({"paths": ["not", "a", "mapping"]})


def test_error_responses_keep_only_problem_json() -> None:
    spec: dict[str, object] = {
        "paths": {
            "/x": {
                "get": {
                    "responses": {
                        "200": {"content": {"application/json": {}}},
                        "404": {
                            "content": {"application/json": {}, "application/problem+json": {}}
                        },
                    }
                }
            }
        }
    }
    strip_json_from_error_responses(spec)
    responses = cast(dict[str, Any], spec["paths"])["/x"]["get"]["responses"]
    assert "application/json" in responses["200"]["content"]
    assert list(responses["404"]["content"]) == ["application/problem+json"]

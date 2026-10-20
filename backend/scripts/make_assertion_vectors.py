"""Write contracts/assertion-vectors.json: assertions signed by the Python side, with the verdict
the verifier must reach. The Go gateway (services/realtime) and the Python API both test against
this one file, so the two implementations of the scheme cannot drift apart.

    cd backend && uv run python -m scripts.make_assertion_vectors
"""

from __future__ import annotations

import hashlib
import hmac
import json
import pathlib
from datetime import UTC, datetime

from app.core.assertion import AUDIENCE, _b64, body_hash, canonical, sign

KEY = "k" * 32
NOW = datetime(2026, 10, 19, 4, 0, tzinfo=UTC)
PATH = "/stream?cursor=12.34"
JTI = "vector-jti-0123456789abcdef"  # any 16 to 64 characters; the Go side ignores it
OUT = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "assertion-vectors.json"


def _claims(**over: object) -> dict[str, object]:
    iat = int(NOW.timestamp())
    base: dict[str, object] = {
        "aud": AUDIENCE,
        "sub": "google-sub-1",
        "email": "admin@example.com",
        "role": "admin",
        "iat": iat,
        "exp": iat + 60,
        "m": "GET",
        "p": PATH,
        "bh": body_hash(b""),
        "jti": JTI,
    }
    base.update(over)
    return base


def _without(key: str) -> dict[str, object]:
    return {k: v for k, v in _claims().items() if k != key}


def _case(name: str, claims: dict[str, object], expect: str, **req: object) -> dict[str, object]:
    return {
        "name": name,
        "header": sign(claims, KEY.encode()),
        "method": req.get("method", "GET"),
        "path": req.get("path", PATH),
        "body": req.get("body", ""),
        "now": req.get("now", int(NOW.timestamp())),
        "expect": expect,
        "principal": (
            {
                "sub": claims.get("sub"),
                "email": claims.get("email"),
                "role": claims.get("role"),
                "email_verified": claims.get("ev") is True,
            }
            if expect == "ok"
            else None
        ),
    }


def build() -> dict[str, object]:
    t = int(NOW.timestamp())
    cases = [
        _case("valid", _claims(), "ok"),
        _case("valid, email verified", _claims(ev=True), "ok"),
        _case("valid, viewer", _claims(role="viewer"), "ok"),
        _case("valid, issued 5 s ahead (inside the skew)", _claims(iat=t + 5, exp=t + 65), "ok"),
        _case("expired beyond skew", _claims(iat=t - 120, exp=t - 60), "expired"),
        _case("issued in the future", _claims(iat=t + 30, exp=t + 90), "issued in the future"),
        _case("lifetime over 60 s", _claims(exp=t + 61), "lifetime too long"),
        _case("wrong audience", _claims(aud="other"), "wrong audience"),
        _case("method mismatch", _claims(), "method mismatch", method="POST"),
        _case("path mismatch", _claims(), "path mismatch", path="/stream?cursor=12.35"),
        _case("body mismatch", _claims(), "body mismatch", body="x"),
        _case("float times", _claims(iat=float(t), exp=float(t + 60)), "bad times"),
        _case("boolean times", _claims(iat=True, exp=t + 60), "bad times"),
        _case("missing identity", _without("role"), "missing identity"),
        # Far outside any real clock: refused before arithmetic, so an int64 verifier cannot
        # overflow on exp - iat or exp + skew.
        _case("times beyond 2^40", _claims(iat=-(2**62), exp=-(2**62) + 10), "bad times"),
        _case("exp beyond 2^40", _claims(iat=t, exp=2**63 - 1), "bad times"),
    ]
    # A correctly signed payload with bytes after the claims object: the JSON must be the whole
    # payload, not its first value.
    trailing = _b64((canonical(_claims()) + " {}").encode("utf-8"))
    cases.append(
        {
            "name": "trailing bytes after the claims",
            "header": "v1."
            + trailing
            + "."
            + _b64(hmac.new(KEY.encode(), trailing.encode("ascii"), hashlib.sha256).digest()),
            "method": "GET",
            "path": PATH,
            "body": "",
            "now": t,
            "expect": "bad payload",
            "principal": None,
        }
    )
    forged = sign(_claims(role="owner"), b"x" * 32)
    cases.append(
        {
            "name": "signed with another key",
            "header": forged,
            "method": "GET",
            "path": PATH,
            "body": "",
            "now": t,
            "expect": "bad signature",
            "principal": None,
        }
    )
    return {"key": KEY, "cases": cases}


def main() -> None:
    OUT.write_text(json.dumps(build(), indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

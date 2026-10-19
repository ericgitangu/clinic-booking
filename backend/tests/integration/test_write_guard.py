"""Staff writes are throttled per person, and a signed assertion works once on a write."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import timedelta

import asyncpg
import httpx
import pytest

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings
from tests.integration.staff_support import (
    KEY,
    OTIENO,
    OWNER,
    PATIENT,
    TUE_10,
    VIEWER,
    Env,
)

pytestmark = pytest.mark.asyncio

LIMIT = 3
WINDOW = 600
UNLOCK = f"/internal/admin/appointments/{uuid.UUID(int=1)}/unlock"
BODY = {"reason": "settled with the patient"}
SAME = "replayed-jti-0123456789abcdef"


async def small(limit: int = LIMIT) -> tuple[Env, httpx.AsyncClient]:
    """An app with a tiny throttle, on the same database as the `env` fixture."""
    clock = FakeClock(FIXED_NOW)
    app = create_app(
        make_settings(
            INTERNAL_SIGNING_KEY=KEY,
            ADMIN_EMAILS=OWNER,
            STAFF_WRITE_LIMIT=limit,
            STAFF_WRITE_WINDOW_SECONDS=WINDOW,
        )
    )
    app.dependency_overrides[get_clock] = lambda: clock
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
    )
    return Env(client, clock), client


# --- the throttle ---------------------------------------------------------------------------------


async def test_the_limit_is_enforced_and_names_when_to_retry(env: Env) -> None:
    other, client = await small()
    try:
        for _ in range(LIMIT):
            resp = await other.req("POST", UNLOCK, body=BODY)
            assert resp.status_code == 404, resp.text  # unknown visit: counted all the same
        over = await other.req("POST", UNLOCK, body=BODY)
        assert over.status_code == 429
        assert over.headers["content-type"].startswith("application/problem+json")
        data = over.json()
        assert data["code"] == "RATE_LIMITED" and data["status"] == 429
        assert str(LIMIT) in data["detail"]
        epoch = int(FIXED_NOW.timestamp())
        assert int(over.headers["retry-after"]) == (epoch // WINDOW + 1) * WINDOW - epoch
    finally:
        await client.aclose()


async def test_the_window_resets_on_the_injected_clock(env: Env) -> None:
    other, client = await small()
    try:
        for _ in range(LIMIT):
            await other.req("POST", UNLOCK, body=BODY)
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 429
        other.clock.set(FIXED_NOW + timedelta(seconds=WINDOW))
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 404  # let through again
        other.clock.set(FIXED_NOW + timedelta(seconds=WINDOW) + timedelta(seconds=30))
        for _ in range(LIMIT - 1):
            assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 404
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 429
    finally:
        await client.aclose()


async def test_each_person_has_their_own_allowance(env: Env) -> None:
    other, client = await small()
    try:
        for _ in range(LIMIT):
            await other.req("POST", UNLOCK, body=BODY)
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 429
        assert (await other.req("POST", UNLOCK, role="admin", body=BODY)).status_code == 404
    finally:
        await client.aclose()


async def test_every_staff_write_counts_and_reads_do_not(env: Env) -> None:
    other, client = await small(limit=100)
    try:
        appt = str(uuid.UUID(int=2))
        writes = [
            ("POST", f"/internal/admin/appointments/{appt}/veto", BODY),
            ("POST", UNLOCK, BODY),
            ("POST", f"/internal/admin/appointments/{appt}/arrived", None),
            ("POST", f"/internal/admin/appointments/{appt}/no-show", None),
            ("PATCH", f"/internal/admin/appointments/{appt}/cancel", BODY),
            (
                "PATCH",
                f"/internal/admin/appointments/{appt}/reschedule",
                {**BODY, "starts_at": TUE_10},
            ),
            (
                "POST",
                "/internal/admin/appointments",
                {**BODY, "doctor_id": str(OTIENO), "patient_id": str(PATIENT), "starts_at": TUE_10},
            ),
            ("DELETE", f"/internal/admin/invites/{appt}", None),
            (
                "POST",
                "/internal/admin/invites",
                {"email": "counted@clinic.co.ke", "role": "viewer"},
            ),
            ("PATCH", f"/internal/admin/access/{VIEWER}", {"role": "viewer"}),
            ("DELETE", "/internal/admin/access/nobody@clinic.co.ke", None),
        ]
        for method, path, body in writes:
            await other.req(method, path, body=body)
        for _ in range(5):
            assert (await other.req("GET", "/internal/admin/appointments")).status_code == 200
        from tests.conftest import owner_dsn

        conn = await asyncpg.connect(owner_dsn())
        try:
            used = await conn.fetchval(
                "SELECT n FROM staff_write_throttle WHERE actor_key = $1",
                hashlib.sha256(OWNER.encode()).hexdigest(),
            )
        finally:
            await conn.close()
        assert used == len(writes)
    finally:
        await client.aclose()


async def test_a_viewer_and_a_stranger_stay_403_and_use_nothing(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    other, client = await small()
    try:
        for _ in range(LIMIT * 3):
            assert (await other.req("POST", UNLOCK, role="viewer", body=BODY)).status_code == 403
            assert (await other.req("POST", UNLOCK, role="none", body=BODY)).status_code == 403
        assert await owner_conn.fetchval("SELECT count(*) FROM staff_write_throttle") == 0
        assert await owner_conn.fetchval("SELECT count(*) FROM assertion_replay") == 0
    finally:
        await client.aclose()


# --- replay ---


async def send(env: Env, headers: dict[str, str], raw: bytes, path: str = UNLOCK) -> httpx.Response:
    return await env.client.request("POST", path, headers=headers, content=raw)


async def test_a_replayed_write_is_refused_and_a_fresh_one_passes(env: Env) -> None:
    headers, raw = env.sign_request("POST", UNLOCK, body=BODY, jti=SAME)
    first = await send(env, headers, raw)
    assert first.status_code == 404  # the write ran (the visit does not exist)
    second = await send(env, headers, raw)
    assert second.status_code == 401
    data = second.json()
    assert data["code"] == "ASSERTION_REPLAYED" and data["status"] == 401
    assert second.headers["content-type"].startswith("application/problem+json")
    fresh_headers, fresh_raw = env.sign_request("POST", UNLOCK, body=BODY)
    assert (await send(env, fresh_headers, fresh_raw)).status_code == 404


async def test_a_replay_does_not_use_up_the_throttle(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    headers, raw = env.sign_request("POST", UNLOCK, body=BODY, jti=SAME)
    await send(env, headers, raw)
    for _ in range(5):
        assert (await send(env, headers, raw)).status_code == 401
    used = await owner_conn.fetchval("SELECT sum(n) FROM staff_write_throttle")
    assert used == 1


async def test_a_throttled_write_does_not_spend_its_assertion(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    other, client = await small(limit=1)
    try:
        await other.req("POST", UNLOCK, body=BODY)
        before = await owner_conn.fetchval("SELECT count(*) FROM assertion_replay")
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 429
        assert await owner_conn.fetchval("SELECT count(*) FROM assertion_replay") == before
    finally:
        await client.aclose()


async def test_reads_may_repeat_an_assertion(env: Env) -> None:
    headers, _ = env.sign_request("GET", "/internal/admin/appointments", jti=SAME)
    for _ in range(3):
        resp = await env.client.get("/internal/admin/appointments", headers=headers)
        assert resp.status_code == 200


async def test_accepting_an_invitation_cannot_be_replayed_either(env: Env) -> None:
    created = await env.req(
        "POST", "/internal/admin/invites", body={"email": "once@clinic.co.ke", "role": "viewer"}
    )
    path = "/internal/admin/invites/accept"
    headers, raw = env.sign_request(
        "POST",
        path,
        role="none",
        email="once@clinic.co.ke",
        body={"token": created.json()["token"]},
        jti=SAME,
    )
    assert (await send(env, headers, raw, path)).status_code == 200
    again = await send(env, headers, raw, path)
    assert again.status_code == 401 and again.json()["code"] == "ASSERTION_REPLAYED"


async def test_expired_replay_keys_are_cleaned_by_the_next_write(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    old = hashlib.sha256(b"old").hexdigest()
    live = hashlib.sha256(b"live").hexdigest()
    await owner_conn.execute(
        "INSERT INTO assertion_replay (replay_key, expires_at) VALUES ($1, $3), ($2, $4)",
        old,
        live,
        FIXED_NOW - timedelta(seconds=1),
        FIXED_NOW + timedelta(seconds=30),
    )
    await env.req("POST", UNLOCK, body=BODY)
    keys = {
        r["replay_key"] for r in await owner_conn.fetch("SELECT replay_key FROM assertion_replay")
    }
    assert old not in keys and live in keys


async def test_the_clean_up_is_bounded(env: Env, owner_conn: asyncpg.Connection) -> None:
    await owner_conn.execute(
        "INSERT INTO assertion_replay (replay_key, expires_at) "
        "SELECT encode(sha256(g::text::bytea), 'hex'), $1 FROM generate_series(1, 120) g",
        FIXED_NOW - timedelta(minutes=5),
    )
    await env.req("POST", UNLOCK, body=BODY)
    left = await owner_conn.fetchval(
        "SELECT count(*) FROM assertion_replay WHERE expires_at < $1", FIXED_NOW
    )
    assert left == 120 - 50  # one batch per write


@pytest.mark.race
@pytest.mark.parametrize("round_", range(4))
async def test_two_identical_writes_at_once_only_one_runs(env: Env, round_: int) -> None:
    headers, raw = env.sign_request("POST", UNLOCK, body=BODY, jti=SAME)
    results = await asyncio.gather(send(env, headers, raw), send(env, headers, raw))
    codes = sorted(r.status_code for r in results)
    assert codes == [401, 404], [r.text for r in results]


async def test_two_legitimate_identical_writes_in_one_second_both_pass(env: Env) -> None:
    first = await env.req("POST", UNLOCK, body=BODY)
    second = await env.req("POST", UNLOCK, body=BODY)  # same second, same body, new assertion
    assert (first.status_code, second.status_code) == (404, 404)
    a, _ = env.sign_request("POST", UNLOCK, body=BODY)
    b, _ = env.sign_request("POST", UNLOCK, body=BODY)
    assert a["X-Internal-Assertion"] != b["X-Internal-Assertion"]


async def test_an_assertion_without_a_jti_is_refused_before_anything_runs(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    import json

    from app.core.assertion import AUDIENCE, body_hash, sign

    raw = json.dumps(BODY).encode()
    claims = {
        "aud": AUDIENCE, "sub": "s", "email": OWNER, "role": "owner", "ev": True,
        "iat": int(FIXED_NOW.timestamp()), "exp": int(FIXED_NOW.timestamp()) + 60,
        "m": "POST", "p": UNLOCK, "bh": body_hash(raw),
    }  # fmt: skip
    resp = await env.client.post(
        UNLOCK, content=raw, headers={"X-Internal-Assertion": sign(claims, KEY.encode())}
    )
    assert resp.status_code == 401 and resp.json()["code"] == "UNAUTHENTICATED"
    assert await owner_conn.fetchval("SELECT count(*) FROM assertion_replay") == 0


async def test_the_replay_row_outlives_the_last_second_the_assertion_can_verify(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    """An assertion issued 5 s ahead (allowed) lives until exp + 5 s = now + 70 s. A replay at that
    very second is still refused, even after another write has run the clean-up."""
    headers, raw = env.sign_request("POST", UNLOCK, body=BODY, jti=SAME, iat_offset=5)
    assert (await send(env, headers, raw)).status_code == 404
    env.clock.set(FIXED_NOW + timedelta(seconds=70))
    assert (await env.req("POST", UNLOCK, body=BODY)).status_code == 404  # runs the clean-up
    replay = await send(env, headers, raw)
    assert replay.status_code == 401 and replay.json()["code"] == "ASSERTION_REPLAYED"
    env.clock.set(FIXED_NOW + timedelta(seconds=71))  # now it cannot verify at all
    expired = await send(env, headers, raw)
    assert expired.status_code == 401 and expired.json()["code"] == "UNAUTHENTICATED"
    # and only past its expiry does a write's clean-up remove the row
    env.clock.set(FIXED_NOW + timedelta(seconds=90))
    await env.req("POST", UNLOCK, body=BODY)
    key = hashlib.sha256(SAME.encode()).hexdigest()
    assert (
        await owner_conn.fetchval(
            "SELECT count(*) FROM assertion_replay WHERE replay_key = $1", key
        )
        == 0
    )


async def test_a_lagging_clock_never_moves_the_window_backwards(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    other, client = await small()
    try:
        other.clock.set(FIXED_NOW + timedelta(seconds=WINDOW))  # an instance already in window w+1
        for _ in range(LIMIT):
            await other.req("POST", UNLOCK, body=BODY)
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 429
        # A request that lands with an earlier clock counts in the recorded window: still refused,
        # and the stored window does not go back.
        other.clock.set(FIXED_NOW)
        assert (await other.req("POST", UNLOCK, body=BODY)).status_code == 429
        epoch = int(FIXED_NOW.timestamp())
        window = await owner_conn.fetchval("SELECT window_id FROM staff_write_throttle")
        assert window == epoch // WINDOW + 1
    finally:
        await client.aclose()


async def test_a_422_counts_toward_the_throttle(env: Env, owner_conn: asyncpg.Connection) -> None:
    other, client = await small()
    try:
        for _ in range(LIMIT):
            bad = await other.req("POST", UNLOCK, body={"reason": "x"})  # too short: 422
            assert bad.status_code == 422
        over = await other.req("POST", UNLOCK, body=BODY)
        assert over.status_code == 429 and over.json()["code"] == "RATE_LIMITED"
    finally:
        await client.aclose()


async def test_if_the_guard_cannot_run_the_write_does_not_either(
    env: Env, owner_conn: asyncpg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """It fails closed: a database error in the guard is a 500 problem, the handler never runs,
    and nothing is left recorded."""
    from sqlalchemy import text

    from app.services import write_guard

    appt = await env.patient_book(TUE_10)
    monkeypatch.setattr(write_guard, "_THROTTLE", text("SELECT * FROM no_such_table"))
    resp = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    assert resp.status_code == 500 and resp.json()["code"] == "INTERNAL_ERROR"
    assert (
        await owner_conn.fetchval("SELECT status FROM appointments WHERE id = $1", uuid.UUID(appt))
        == "booked"
    )
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_action_audit") == 0
    assert await owner_conn.fetchval("SELECT count(*) FROM assertion_replay") == 0  # rolled back


def test_every_guarded_write_documents_its_429_with_a_retry_after() -> None:
    import json
    import pathlib

    spec = json.loads(
        (pathlib.Path(__file__).resolve().parents[3] / "contracts" / "openapi.json").read_text()
    )
    guarded = []
    for path, operations in spec["paths"].items():
        for method, op in operations.items():
            if path.startswith("/internal/admin") and method in ("post", "patch", "delete"):
                if path.endswith("/invites/accept"):
                    continue  # its own attempt limit
                guarded.append((method, path))
                resp = op["responses"].get("429")
                assert resp is not None, (method, path)
                assert "Retry-After" in resp["headers"], (method, path)
    assert len(guarded) >= 14

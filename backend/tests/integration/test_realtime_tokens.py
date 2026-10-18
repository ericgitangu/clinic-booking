"""Token endpoints: scope, TTL, the rate limit, the daily cap, the origin check, the refusals."""

from __future__ import annotations

import base64
import json
from datetime import timedelta

import asyncpg
import httpx
import pytest
from fastapi import FastAPI

from app.core.clock import FakeClock
from tests.conftest import FIXED_NOW, seeded_doctor_id
from tests.integration.realtime_support import TEST_KEY, RecordingPublisher, make_realtime_app
from tests.integration.test_access import (
    ADMIN,
    OWNER,
    STRANGER,
    VIEWER,
    _headers,
    staff,  # noqa: F401  # a fixture, used by name
)
from tests.integration.test_access import (
    KEY as SIGNING_KEY,
)

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
DAY = "2026-10-26"
PATH = "/realtime/token/patient"
ADMIN_PATH = "/internal/realtime/token/admin"
WEB = "http://localhost:3000"  # make_settings' WEB_ORIGIN


def _client(app: FastAPI) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


def _claims(token: str) -> dict[str, object]:
    body = token.split(".")[1]
    claims: dict[str, object] = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    return claims


def _body(**kw: str) -> dict[str, str]:
    return {"doctor_id": OTIENO, "date": DAY, **kw}


def _from(ip: str, **extra: str) -> dict[str, str]:
    return {"x-client-ip": ip, **extra}


async def test_a_patient_gets_a_five_minute_subscribe_only_token_for_one_day(
    realtime_clean: None,
) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        resp = await c.post(PATH, json=_body(), headers=_from("203.0.113.5", origin=WEB))
    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    channel = f"slots:{OTIENO}:{DAY}"
    assert body["channel"] == channel and body["ttl_seconds"] == 300
    assert body["stream_url"].startswith("https://main.realtime.ably.net/event-stream?channels=")
    claims = _claims(body["token"])
    assert json.loads(str(claims["x-ably-capability"])) == {channel: ["subscribe"]}
    assert int(str(claims["exp"])) - int(str(claims["iat"])) == 300
    assert claims["iat"] == int(FIXED_NOW.timestamp())
    assert TEST_KEY.split(":")[1] not in resp.text  # the secret never leaves the server


async def test_a_patient_token_cannot_reach_the_admin_channel(realtime_clean: None) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        resp = await c.post(PATH, json=_body(), headers=_from("203.0.113.6"))
    capability = json.loads(str(_claims(resp.json()["token"])["x-ably-capability"]))
    assert "admin:events" not in capability and list(capability) == [resp.json()["channel"]]
    assert all(ops == ["subscribe"] for ops in capability.values())


async def test_the_rate_limit_is_per_address_and_carries_retry_after(realtime_clean: None) -> None:
    app = make_realtime_app(RecordingPublisher(), REALTIME_TOKEN_PER_MINUTE=3)
    async with _client(app) as c:
        codes = [
            (await c.post(PATH, json=_body(), headers=_from("203.0.113.7"))).status_code
            for _ in range(5)
        ]
        other = await c.post(PATH, json=_body(), headers=_from("203.0.113.8"))
    assert codes == [200, 200, 200, 429, 429]
    assert other.status_code == 200
    async with _client(app) as c:
        limited = await c.post(PATH, json=_body(), headers=_from("203.0.113.7"))
    assert limited.status_code == 429
    assert limited.headers["content-type"].startswith("application/problem+json")
    assert limited.json()["code"] == "RATE_LIMITED" and limited.headers["retry-after"] == "60"


async def test_the_daily_cap_is_durable_and_shared_across_app_instances(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    ip = _from("203.0.113.9")
    async with _client(
        make_realtime_app(
            RecordingPublisher(), REALTIME_TOKEN_DAILY_CAP=3, REALTIME_TOKEN_PER_MINUTE=100
        )
    ) as first:
        a = [(await first.post(PATH, json=_body(), headers=ip)).status_code for _ in range(2)]
    # A second instance (fresh in-memory limiter) sees the same durable count.
    async with _client(
        make_realtime_app(
            RecordingPublisher(), REALTIME_TOKEN_DAILY_CAP=3, REALTIME_TOKEN_PER_MINUTE=100
        )
    ) as second:
        b = [(await second.post(PATH, json=_body(), headers=ip)).status_code for _ in range(2)]
        capped = await second.post(PATH, json=_body(), headers=ip)
    assert a + b == [200, 200, 200, 429]
    assert capped.json()["code"] == "RATE_LIMITED"
    assert 0 < int(capped.headers["retry-after"]) <= 86_400
    assert await owner_conn.fetchval("SELECT n FROM realtime_token_cap") == 3


async def test_the_daily_cap_resets_the_next_day_in_place(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    clock = FakeClock(FIXED_NOW)
    app = make_realtime_app(
        RecordingPublisher(), clock=clock, REALTIME_TOKEN_DAILY_CAP=1, REALTIME_TOKEN_PER_MINUTE=100
    )
    ip = _from("203.0.113.10")
    async with _client(app) as c:
        assert (await c.post(PATH, json=_body(), headers=ip)).status_code == 200
        assert (await c.post(PATH, json=_body(), headers=ip)).status_code == 429
        clock.set(FIXED_NOW + timedelta(days=1))
        assert (await c.post(PATH, json=_body(), headers=ip)).status_code == 200
    assert await owner_conn.fetchval("SELECT count(*) FROM realtime_token_cap") == 1  # same row


async def test_ipv6_addresses_in_one_slash_64_share_a_cap(realtime_clean: None) -> None:
    app = make_realtime_app(
        RecordingPublisher(), REALTIME_TOKEN_DAILY_CAP=2, REALTIME_TOKEN_PER_MINUTE=100
    )
    async with _client(app) as c:
        r = [
            (await c.post(PATH, json=_body(), headers=_from(ip))).status_code
            for ip in (
                "2001:db8:aa:bb:1::1",
                "2001:db8:aa:bb:ffff:eeee:dddd:cccc",
                "2001:db8:aa:bb:2::2",
                "2001:db8:aa:cc::1",  # another /64
            )
        ]
    assert r == [200, 200, 429, 200]


async def test_a_foreign_origin_is_refused_and_no_origin_or_the_site_is_allowed(
    realtime_clean: None,
) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        bad = await c.post(
            PATH, json=_body(), headers=_from("203.0.113.11", origin="https://evil.example")
        )
        good = await c.post(PATH, json=_body(), headers=_from("203.0.113.11", origin=WEB))
        none = await c.post(PATH, json=_body(), headers=_from("203.0.113.11"))
    assert bad.status_code == 403 and bad.json()["code"] == "FORBIDDEN"
    assert good.status_code == 200 and none.status_code == 200


async def test_a_body_that_is_not_json_is_refused(realtime_clean: None) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        form = await c.post(PATH, data={"doctor_id": OTIENO, "date": DAY})
        text = await c.post(
            PATH, content=json.dumps(_body()), headers={"content-type": "text/plain"}
        )
    assert form.status_code == text.status_code == 422
    assert form.json()["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"doctor_id": OTIENO, "date": "2026-10-18"}, 422, "DATE_OUT_OF_RANGE"),  # a past day
        ({"doctor_id": OTIENO, "date": "2027-06-01"}, 422, "DATE_OUT_OF_RANGE"),  # past the horizon
        (
            {"doctor_id": "00000000-0000-4000-8000-000000000000", "date": DAY},
            404,
            "DOCTOR_NOT_FOUND",
        ),
        ({"doctor_id": "nope", "date": DAY}, 422, "VALIDATION_ERROR"),
        ({"doctor_id": OTIENO, "date": DAY, "extra": "x"}, 422, "VALIDATION_ERROR"),
    ],
)
async def test_bad_requests_get_the_usual_problems(
    realtime_clean: None, body: dict[str, str], status: int, code: str
) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        resp = await c.post(PATH, json=body, headers=_from("203.0.113.12"))
    assert resp.status_code == status and resp.json()["code"] == code


async def test_with_no_key_the_token_endpoints_say_push_is_off(realtime_clean: None) -> None:
    app = make_realtime_app(key=None, INTERNAL_SIGNING_KEY=SIGNING_KEY, ADMIN_EMAILS=OWNER)
    async with _client(app) as c:
        resp = await c.post(PATH, json=_body(), headers=_from("203.0.113.13"))
        admin = await c.post(
            ADMIN_PATH, headers=_headers("POST", ADMIN_PATH, email=OWNER, role="owner")
        )
    for r in (resp, admin):
        assert r.status_code == 503 and r.json()["code"] == "REALTIME_UNAVAILABLE"


async def test_when_the_month_budget_is_spent_tokens_are_refused_so_clients_poll(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    app = make_realtime_app(RecordingPublisher(), REALTIME_PUBLISH_CAP_PER_MONTH=10)
    await owner_conn.execute(
        "INSERT INTO realtime_publish_budget (month, used) VALUES ('2026-10-01', 10)"
    )
    async with _client(app) as c:
        resp = await c.post(PATH, json=_body(), headers=_from("203.0.113.14"))
    assert resp.status_code == 503 and resp.json()["code"] == "REALTIME_UNAVAILABLE"


@pytest.mark.parametrize(
    ("who", "status"), [(OWNER, 200), (ADMIN, 200), (VIEWER, 403), (STRANGER, 403)]
)
async def test_the_admin_token_needs_an_owner_or_admin_assertion(
    realtime_clean: None,
    staff: None,  # noqa: F811  # the fixture is imported by name
    who: str,
    status: int,
) -> None:
    role = {OWNER: "owner", ADMIN: "admin", VIEWER: "viewer", STRANGER: "none"}[who]
    app = make_realtime_app(
        RecordingPublisher(), INTERNAL_SIGNING_KEY=SIGNING_KEY, ADMIN_EMAILS=OWNER
    )
    async with _client(app) as c:
        resp = await c.post(ADMIN_PATH, headers=_headers("POST", ADMIN_PATH, email=who, role=role))
    assert resp.status_code == status, resp.text
    if status == 200:
        capability = json.loads(str(_claims(resp.json()["token"])["x-ably-capability"]))
        assert capability == {"admin:events": ["subscribe"]}
        assert resp.json()["ttl_seconds"] == 300


async def test_the_admin_token_without_an_assertion_is_a_401(realtime_clean: None) -> None:
    app = make_realtime_app(
        RecordingPublisher(), INTERNAL_SIGNING_KEY=SIGNING_KEY, ADMIN_EMAILS=OWNER
    )
    async with _client(app) as c:
        assert (await c.post(ADMIN_PATH)).status_code == 401


# --- the client address: never guessed, IPv4-mapped unwrapped; no-store on every answer ---------


async def test_a_request_without_a_usable_client_address_is_refused_not_guessed(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        # The test transport's socket peer is 127.0.0.1; it must never stand in for the client.
        absent = await c.post(PATH, json=_body())
        for bad in ("", "not-an-ip", "999.1.1.1", "203.0.113.5, 198.51.100.1"):
            wrong = await c.post(PATH, json=_body(), headers=_from(bad))
            assert wrong.status_code == 400, bad
            assert wrong.json()["code"] == "CLIENT_ADDRESS_UNKNOWN"
    assert absent.status_code == 400 and absent.json()["code"] == "CLIENT_ADDRESS_UNKNOWN"
    assert await owner_conn.fetchval("SELECT count(*) FROM realtime_token_cap") == 0


async def test_ipv4_mapped_ipv6_addresses_count_as_the_ipv4_client(realtime_clean: None) -> None:
    app = make_realtime_app(
        RecordingPublisher(), REALTIME_TOKEN_DAILY_CAP=2, REALTIME_TOKEN_PER_MINUTE=100
    )
    async with _client(app) as c:
        same = [
            (await c.post(PATH, json=_body(), headers=_from(ip))).status_code
            for ip in ("203.0.113.60", "::ffff:203.0.113.60", "::ffff:cb00:713c")
        ]
        other = await c.post(PATH, json=_body(), headers=_from("::ffff:203.0.113.61"))
    assert same == [200, 200, 429], "one client, written three ways"
    assert other.status_code == 200, "a different mapped client is not in the same bucket"


@pytest.mark.parametrize(
    ("headers", "body", "status"),
    [
        (_from("203.0.113.70"), _body(), 200),
        ({}, _body(), 400),  # no client address
        (_from("203.0.113.71", origin="https://evil.example"), _body(), 403),
        (_from("203.0.113.72"), {"doctor_id": "nope", "date": DAY}, 422),
        (_from("203.0.113.73"), _body(date="2020-01-01"), 422),
        (
            _from("203.0.113.74"),
            {"doctor_id": "00000000-0000-4000-8000-000000000000", "date": DAY},
            404,
        ),
    ],
)
async def test_every_answer_of_the_patient_token_route_is_no_store(
    realtime_clean: None, headers: dict[str, str], body: dict[str, str], status: int
) -> None:
    async with _client(make_realtime_app(RecordingPublisher())) as c:
        resp = await c.post(PATH, json=body, headers=headers)
    assert resp.status_code == status, resp.text
    assert resp.headers["cache-control"] == "no-store"


async def test_the_rate_limited_and_unavailable_answers_are_no_store_too(
    realtime_clean: None,
) -> None:
    limited_app = make_realtime_app(RecordingPublisher(), REALTIME_TOKEN_PER_MINUTE=1)
    async with _client(limited_app) as c:
        await c.post(PATH, json=_body(), headers=_from("203.0.113.80"))
        limited = await c.post(PATH, json=_body(), headers=_from("203.0.113.80"))
    off = make_realtime_app(key=None)
    async with _client(off) as c:
        unavailable = await c.post(PATH, json=_body(), headers=_from("203.0.113.81"))
    assert limited.status_code == 429 and unavailable.status_code == 503
    for resp in (limited, unavailable):
        assert resp.headers["cache-control"] == "no-store"

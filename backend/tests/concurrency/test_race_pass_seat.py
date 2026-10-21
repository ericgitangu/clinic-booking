"""Several people taking the last seat of a reviewer pass at once: exactly one gets it."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings
from tests.integration.staff_support import KEY, OWNER, Env
from tests.integration.staff_support import env as env  # noqa: F401  # shared fixture

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

PEOPLE = 12


@pytest_asyncio.fixture
async def other_instances(env: Env) -> AsyncIterator[list[Env]]:  # noqa: F811  # shared fixture
    """Two more API instances over the same database, each with its own connection pool."""
    clients: list[httpx.AsyncClient] = []
    out: list[Env] = []
    for _ in range(2):
        clock = FakeClock(FIXED_NOW)
        app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
        app.dependency_overrides[get_clock] = lambda clock=clock: clock
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
        )
        clients.append(client)
        out.append(Env(client, clock))
    yield out
    for client in clients:
        await client.aclose()


async def _accept(env: Env, token: str, email: str) -> int:
    resp = await env.req(
        "POST",
        "/internal/admin/passes/accept",
        role="none",
        email=email,
        body={"token": token},
    )
    return resp.status_code


@pytest.mark.parametrize("seats", [1, 3])
async def test_concurrent_accepts_never_take_more_seats_than_there_are(
    env: Env,  # noqa: F811  # shared fixture
    other_instances: list[Env],
    owner_conn: asyncpg.Connection,
    seats: int,
) -> None:
    made = await env.req("POST", "/internal/admin/passes", body={"max_uses": seats})
    token = made.json()["token"]
    instances = [env, *other_instances]
    codes = await asyncio.gather(
        *(_accept(instances[i % 3], token, f"racer{i}@example.org") for i in range(PEOPLE))
    )
    assert sorted(codes) == [200] * seats + [404] * (PEOPLE - seats), codes
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_pass_uses") == seats
    granted = await owner_conn.fetchval(
        "SELECT count(*) FROM staff_access WHERE email LIKE 'racer%'"
    )
    assert granted == seats


async def test_the_same_person_racing_themselves_takes_one_seat(
    env: Env,  # noqa: F811  # shared fixture
    other_instances: list[Env],
    owner_conn: asyncpg.Connection,
) -> None:
    made = await env.req("POST", "/internal/admin/passes", body={"max_uses": 2})
    token = made.json()["token"]
    instances = [env, *other_instances]
    codes = await asyncio.gather(
        *(_accept(instances[i % 3], token, "twin@example.org") for i in range(9))
    )
    assert set(codes) == {200}
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_pass_uses") == 1


async def test_one_person_on_two_passes_at_once_takes_one_seat_in_all(
    env: Env,  # noqa: F811  # shared fixture
    other_instances: list[Env],
    owner_conn: asyncpg.Connection,
) -> None:
    first = (await env.req("POST", "/internal/admin/passes", body={"max_uses": 3})).json()["token"]
    second = (await env.req("POST", "/internal/admin/passes", body={"max_uses": 3})).json()["token"]
    for n in range(5):
        who = f"both{n}@example.org"
        codes = await asyncio.gather(
            _accept(env, first, who), _accept(other_instances[0], second, who)
        )
        assert set(codes) == {200}, codes
        uses = await owner_conn.fetchval(
            "SELECT count(*) FROM staff_pass_uses WHERE email = $1", who
        )
        assert uses == 1, who

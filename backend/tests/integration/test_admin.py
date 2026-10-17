"""``/internal/admin/*``: aggregates, paging, lineage and the assertion gate."""

from __future__ import annotations

import io
import logging
import secrets
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.deps import get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.core.logging import JsonFormatter
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

KEY = secrets.token_hex(24)  # fresh per run: a throwaway key, never a literal
OWNER = "owner@clinic.example"
OTIENO = seeded_doctor_id("otieno")
KAMAU = seeded_doctor_id("kamau")
AMINA = seeded_patient_id("amina")
BRIAN = seeded_patient_id("brian")
WANJIRU = seeded_patient_id("wanjiru")

A1 = uuid.UUID("00000000-0000-4000-8000-0000000000a1")  # otieno, booked, Tue 20 Oct 09:00 EAT
A2 = uuid.UUID("00000000-0000-4000-8000-0000000000a2")  # otieno, cancelled, Wed 21 Oct 10:00 EAT
A3 = uuid.UUID("00000000-0000-4000-8000-0000000000a3")  # kamau, rescheduled, Thu 22 Oct 11:00 EAT
A4 = uuid.UUID("00000000-0000-4000-8000-0000000000a4")  # otieno, booked, same slot time as A3

Signer = Callable[..., dict[str, str]]


def _utc(day: int, hour: int, minute: int = 0, month: int = 10) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


def _eat(day: int, hour: int) -> datetime:
    return _utc(day, hour) - timedelta(hours=3)


@pytest_asyncio.fixture
async def admin_client() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
def signed() -> Signer:
    def make(
        path: str,
        *,
        role: str = "owner",
        email: str = OWNER,
        method: str = "GET",
        body: bytes = b"",
        iat: datetime = FIXED_NOW,
        key: str = KEY,
        ttl: int = 60,
    ) -> dict[str, str]:
        claims: dict[str, object] = {
            "aud": AUDIENCE,
            "sub": "sub-1",
            "email": email,
            "role": role,
            "iat": int(iat.timestamp()),
            "exp": int(iat.timestamp()) + ttl,
            "m": method,
            "p": path,
            "bh": body_hash(body),
        }
        return {"X-Internal-Assertion": sign(claims, key.encode("utf-8"))}

    return make


async def _get(client: httpx.AsyncClient, signer: Signer, path: str, **kw: Any) -> httpx.Response:
    return await client.get(path, headers=signer(path, **kw))


async def _insert_appointment(
    conn: asyncpg.Connection,
    appt_id: uuid.UUID,
    doctor: uuid.UUID,
    patient: uuid.UUID,
    starts_at: datetime,
    *,
    cancelled_at: datetime | None = None,
) -> None:
    if cancelled_at is None:
        await conn.execute(
            "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
            "VALUES ($1, $2, $3, $4, $5)",
            appt_id,
            doctor,
            patient,
            starts_at,
            starts_at + timedelta(minutes=30),
        )
    else:
        await conn.execute(
            "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at, status, "
            "cancellation_reason, cancelled_at) VALUES ($1, $2, $3, $4, $5, 'cancelled', "
            "'patient requested', $6)",
            appt_id,
            doctor,
            patient,
            starts_at,
            starts_at + timedelta(minutes=30),
            cancelled_at,
        )


async def _event(
    conn: asyncpg.Connection,
    appt: uuid.UUID,
    doctor: uuid.UUID,
    kind: str,
    occurred_at: datetime,
    *,
    start: datetime,
    frm: datetime | None = None,
    to: datetime | None = None,
) -> None:
    await conn.execute(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, from_starts_at, "
        "to_starts_at, local_date, from_local_date, occurred_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        appt,
        doctor,
        kind,
        frm,
        to,
        (start + timedelta(hours=3)).date(),
        (frm + timedelta(hours=3)).date() if frm else None,
        occurred_at,
    )


@pytest_asyncio.fixture
async def data(owner_conn: asyncpg.Connection, reset_appointments: None) -> None:
    """Three real-looking histories plus one more booking that shares A3's start time.

    Activity (event times, UTC): A1 booked 16 Oct 21:30 (= 17 Oct 00:30 clinic time, so it must
    count on the 17th), A2 booked 16 Oct 09:00 and cancelled 17 Oct 10:00, A3 booked 17 Oct 07:00
    and moved 17 Oct 08:00 from 10:00 to 11:00 clinic time.
    """
    s1, s2, s3 = _eat(20, 9), _eat(21, 10), _eat(22, 11)
    await _insert_appointment(owner_conn, A1, OTIENO, AMINA, s1)
    await _insert_appointment(owner_conn, A2, OTIENO, BRIAN, s2, cancelled_at=_utc(17, 10))
    await _insert_appointment(owner_conn, A3, KAMAU, WANJIRU, s3)
    await _insert_appointment(owner_conn, A4, OTIENO, AMINA, s3)

    await _event(owner_conn, A1, OTIENO, "booked", _utc(16, 21, 30), start=s1, to=s1)
    await _event(owner_conn, A2, OTIENO, "booked", _utc(16, 9), start=s2, to=s2)
    await _event(owner_conn, A2, OTIENO, "cancelled", _utc(17, 10), start=s2, frm=s2)
    await _event(owner_conn, A3, KAMAU, "booked", _utc(17, 7), start=_eat(22, 10), to=_eat(22, 10))
    await _event(
        owner_conn, A3, KAMAU, "rescheduled", _utc(17, 8), start=s3, frm=_eat(22, 10), to=s3
    )


# --- authentication -------------------------------------------------------------------------

ADMIN_PATHS = [
    "/internal/admin/metrics?from=2026-10-16&to=2026-10-18",
    "/internal/admin/appointments",
    f"/internal/admin/appointments/{A1}/lineage",
]


@pytest.mark.parametrize("path", ADMIN_PATHS)
async def test_no_assertion_is_401(admin_client: httpx.AsyncClient, path: str) -> None:
    resp = await admin_client.get(path)
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "UNAUTHENTICATED"


@pytest.mark.parametrize("path", ADMIN_PATHS)
async def test_patient_role_is_403(
    admin_client: httpx.AsyncClient, signed: Signer, path: str
) -> None:
    resp = await _get(admin_client, signed, path, role="patient")
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_assertion_for_another_path_is_401(
    admin_client: httpx.AsyncClient, signed: Signer
) -> None:
    headers = signed("/internal/admin/appointments?limit=1")
    resp = await admin_client.get("/internal/admin/appointments?limit=100", headers=headers)
    assert resp.status_code == 401


async def test_assertion_for_another_method_is_401(
    admin_client: httpx.AsyncClient, signed: Signer
) -> None:
    path = "/internal/admin/appointments"
    resp = await admin_client.get(path, headers=signed(path, method="POST"))
    assert resp.status_code == 401


async def test_wrong_key_is_401(admin_client: httpx.AsyncClient, signed: Signer) -> None:
    resp = await _get(
        admin_client, signed, "/internal/admin/appointments", key=secrets.token_hex(24)
    )
    assert resp.status_code == 401


async def test_expired_assertion_is_401(admin_client: httpx.AsyncClient, signed: Signer) -> None:
    resp = await _get(
        admin_client, signed, "/internal/admin/appointments", iat=FIXED_NOW - timedelta(seconds=90)
    )
    assert resp.status_code == 401


async def test_replay_inside_the_lifetime_is_accepted_but_not_after(
    admin_client: httpx.AsyncClient, signed: Signer
) -> None:
    # Documented behaviour: no replay store; a byte-identical request works until it expires.
    path = "/internal/admin/appointments?limit=1"
    headers = signed(path, iat=FIXED_NOW - timedelta(seconds=30))
    assert (await admin_client.get(path, headers=headers)).status_code == 200
    assert (await admin_client.get(path, headers=headers)).status_code == 200
    stale = signed(path, iat=FIXED_NOW - timedelta(seconds=66))
    assert (await admin_client.get(path, headers=stale)).status_code == 401


async def test_unconfigured_key_closes_the_endpoints(
    client: httpx.AsyncClient, signed: Signer
) -> None:
    path = "/internal/admin/appointments"
    resp = await client.get(path, headers=signed(path))
    assert resp.status_code == 401


# --- metrics --------------------------------------------------------------------------------


async def test_metrics_series_totals_and_local_day_bucketing(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, "/internal/admin/metrics?from=2026-10-16&to=2026-10-18")
    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body["range"] == {"from": "2026-10-16", "to": "2026-10-18"}
    assert body["bucket"] == "day"
    assert body["series"] == [
        {"bucket_start": "2026-10-16T00:00:00", "booked": 1, "rescheduled": 0, "cancelled": 0},
        # A1's booking at 21:30 UTC on the 16th happened at 00:30 on the 17th, clinic time.
        {"bucket_start": "2026-10-17T00:00:00", "booked": 2, "rescheduled": 1, "cancelled": 1},
    ]
    assert body["totals"] == {"booked": 3, "rescheduled": 1, "cancelled": 1, "upcoming_active": 3}
    by_name = {d["name"]: d for d in body["per_doctor"]}
    # Activity is by occurred_at, load by starts_at: no visit starts in this range.
    assert by_name["Dr. Achieng Otieno"]["cancelled_actions"] == 1
    assert by_name["Dr. Achieng Otieno"]["booked_visits"] == 0


async def test_metrics_per_doctor_load(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    # Mon 19 to Mon 26 Oct (exclusive): five working days for Dr. Otieno at 16 slots a day.
    resp = await _get(admin_client, signed, "/internal/admin/metrics?from=2026-10-19&to=2026-10-26")
    assert resp.status_code == 200
    body = resp.json()
    by_id = {d["doctor_id"]: d for d in body["per_doctor"]}
    otieno = by_id[str(OTIENO)]
    assert otieno["booked_visits"] == 2  # A1 and A4; A2 is cancelled
    assert otieno["capacity"] == 80
    assert otieno["utilization"] == pytest.approx(2 / 80)
    assert by_id[str(KAMAU)]["booked_visits"] == 1
    assert by_id[str(KAMAU)]["capacity"] == 80
    # Dr. Rotich works Mon, Wed and Fri 08:00-14:00: three days of 12 slots.
    rotich = by_id[str(seeded_doctor_id("rotich"))]
    assert rotich["capacity"] == 36
    assert rotich["utilization"] == 0.0
    assert len(body["per_doctor"]) == 5


async def test_metrics_hour_bucket(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(
        admin_client,
        signed,
        "/internal/admin/metrics?from=2026-10-17&to=2026-10-18&bucket=hour",
    )
    assert resp.status_code == 200
    starts = [p["bucket_start"] for p in resp.json()["series"]]
    # 00:30 booked, 10:00 and 11:00 (A3 booked and moved), 13:00 (A2 cancelled), clinic time.
    assert starts == [
        "2026-10-17T00:00:00",
        "2026-10-17T10:00:00",
        "2026-10-17T11:00:00",
        "2026-10-17T13:00:00",
    ]


async def test_metrics_empty_range_is_zeroes_not_an_error(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, "/internal/admin/metrics?from=2026-01-01&to=2026-01-08")
    assert resp.status_code == 200
    body = resp.json()
    assert body["series"] == []
    assert (body["totals"]["booked"], body["totals"]["cancelled"]) == (0, 0)
    assert body["totals"]["upcoming_active"] == 3
    assert all(d["booked_visits"] == 0 and d["cancelled_actions"] == 0 for d in body["per_doctor"])
    assert all(d["utilization"] == 0.0 for d in body["per_doctor"])


async def test_metrics_with_no_data_at_all(
    admin_client: httpx.AsyncClient, signed: Signer, reset_appointments: None
) -> None:
    resp = await _get(admin_client, signed, "/internal/admin/metrics?from=2026-10-12&to=2026-10-19")
    assert resp.status_code == 200
    body = resp.json()
    assert body["series"] == []
    assert body["totals"] == {"booked": 0, "rescheduled": 0, "cancelled": 0, "upcoming_active": 0}


async def test_metrics_zero_capacity_gives_null_utilization(
    admin_client: httpx.AsyncClient, signed: Signer, reset_appointments: None
) -> None:
    # Sunday 25 Oct only: nobody in the seed works on Sundays.
    resp = await _get(admin_client, signed, "/internal/admin/metrics?from=2026-10-25&to=2026-10-26")
    assert resp.status_code == 200
    assert all(d["capacity"] == 0 and d["utilization"] is None for d in resp.json()["per_doctor"])


@pytest.mark.parametrize(
    "query",
    [
        "from=2026-10-18&to=2026-10-16",
        "from=2026-10-16&to=2026-10-16",
        "from=2026-01-01&to=2026-04-02",  # 91 days of day buckets
        "from=2026-10-01&to=2026-10-09&bucket=hour",  # 8 days of hour buckets
        "from=2026-10-01&to=2026-10-08&bucket=week",
        "from=not-a-date&to=2026-10-08",
        "to=2026-10-08",
    ],
)
async def test_metrics_bad_range_is_422(
    admin_client: httpx.AsyncClient, signed: Signer, query: str
) -> None:
    resp = await _get(admin_client, signed, f"/internal/admin/metrics?{query}")
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_metrics_limits_are_inclusive(
    admin_client: httpx.AsyncClient, signed: Signer, reset_appointments: None
) -> None:
    ok_day = await _get(
        admin_client, signed, "/internal/admin/metrics?from=2026-01-01&to=2026-04-01"
    )
    ok_hour = await _get(
        admin_client,
        signed,
        "/internal/admin/metrics?from=2026-10-01&to=2026-10-08&bucket=hour",
    )
    assert (ok_day.status_code, ok_hour.status_code) == (200, 200)


# --- appointments list ----------------------------------------------------------------------


async def test_list_orders_by_start_descending_with_all_fields(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, "/internal/admin/appointments")
    assert resp.status_code == 200
    body = resp.json()
    assert body["next_cursor"] is None
    starts = [i["starts_at"] for i in body["items"]]
    assert starts == sorted(starts, reverse=True)
    assert len(body["items"]) == 4
    cancelled = next(i for i in body["items"] if i["id"] == str(A2))
    assert cancelled["status"] == "cancelled"
    assert cancelled["cancellation_reason"] == "patient requested"
    assert cancelled["doctor_name"] == "Dr. Achieng Otieno"
    assert cancelled["patient_name"] == "Brian Otieno"
    assert cancelled["starts_at"].endswith("+03:00")


async def test_list_pages_by_cursor_without_gaps_or_repeats(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        path = "/internal/admin/appointments?limit=1"
        if cursor:
            path += f"&cursor={cursor}"
        body = (await _get(admin_client, signed, path)).json()
        seen += [i["id"] for i in body["items"]]
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
    # A3 and A4 start at the same instant, so the id breaks the tie.
    assert pages == 4
    assert len(seen) == len(set(seen)) == 4
    tied = [i for i in seen if i in {str(A3), str(A4)}]
    assert tied == sorted(tied, reverse=True)
    assert seen[-1] == str(A1)


async def test_list_filters(admin_client: httpx.AsyncClient, signed: Signer, data: None) -> None:
    cancelled = await _get(admin_client, signed, "/internal/admin/appointments?status=cancelled")
    assert [i["id"] for i in cancelled.json()["items"]] == [str(A2)]

    booked = await _get(admin_client, signed, "/internal/admin/appointments?status=booked")
    assert {i["id"] for i in booked.json()["items"]} == {str(A1), str(A3), str(A4)}

    kamau = await _get(admin_client, signed, f"/internal/admin/appointments?doctor_id={KAMAU}")
    assert [i["id"] for i in kamau.json()["items"]] == [str(A3)]

    # from is inclusive and to exclusive, in clinic-local dates: 21 Oct only holds A2.
    day = await _get(
        admin_client, signed, "/internal/admin/appointments?from=2026-10-21&to=2026-10-22"
    )
    assert [i["id"] for i in day.json()["items"]] == [str(A2)]


async def test_list_empty_range(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(
        admin_client, signed, "/internal/admin/appointments?from=2027-01-01&to=2027-01-08"
    )
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "next_cursor": None}


@pytest.mark.parametrize(
    "query",
    [
        "limit=101",
        "limit=0",
        "limit=abc",
        "status=pending",
        "cursor=not-a-cursor",
        "cursor=e30",  # {} is valid base64 JSON but not the cursor shape
        "doctor_id=nope",
        "from=2026-10-22&to=2026-10-21",
    ],
)
async def test_list_bad_input_is_422(
    admin_client: httpx.AsyncClient, signed: Signer, query: str
) -> None:
    resp = await _get(admin_client, signed, f"/internal/admin/appointments?{query}")
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_list_limit_100_is_allowed(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, "/internal/admin/appointments?limit=100")
    assert resp.status_code == 200


# --- lineage --------------------------------------------------------------------------------


async def test_lineage_of_a_rescheduled_appointment(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, f"/internal/admin/appointments/{A3}/lineage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["appointment_id"] == str(A3)
    kinds = [e["event_type"] for e in body["events"]]
    assert kinds == ["booked", "rescheduled"]
    moved = body["events"][1]
    assert moved["from_starts_at"].startswith("2026-10-22T10:00:00")
    assert moved["to_starts_at"].startswith("2026-10-22T11:00:00")
    ids = [e["id"] for e in body["events"]]
    assert ids == sorted(ids)


async def test_lineage_of_a_cancelled_appointment(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, f"/internal/admin/appointments/{A2}/lineage")
    assert [e["event_type"] for e in resp.json()["events"]] == ["booked", "cancelled"]


async def test_lineage_unknown_id_is_404(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    missing = uuid.uuid4()
    resp = await _get(admin_client, signed, f"/internal/admin/appointments/{missing}/lineage")
    assert resp.status_code == 404
    assert resp.json()["code"] == "APPOINTMENT_NOT_FOUND"


async def test_lineage_of_an_appointment_without_events_is_empty(
    admin_client: httpx.AsyncClient, signed: Signer, data: None
) -> None:
    resp = await _get(admin_client, signed, f"/internal/admin/appointments/{A4}/lineage")
    assert resp.status_code == 200
    assert resp.json()["events"] == []


async def test_lineage_non_uuid_is_422(admin_client: httpx.AsyncClient, signed: Signer) -> None:
    resp = await _get(admin_client, signed, "/internal/admin/appointments/nope/lineage")
    assert resp.status_code == 422


# --- refusals are logged with a reason and no claim values ------------------------------------


async def _refusal_logs(
    client: httpx.AsyncClient, path: str, headers: dict[str, str]
) -> tuple[httpx.Response, str]:
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        resp = await client.get(path, headers=headers)
    finally:
        root.removeHandler(handler)
    return resp, buffer.getvalue()


async def test_a_refused_assertion_logs_why_but_none_of_its_values(
    admin_client: httpx.AsyncClient, signed: Signer
) -> None:
    path = "/internal/admin/appointments"
    good = signed(path)
    version, payload, _ = good["X-Internal-Assertion"].split(".")
    cases = {
        "missing header": {},
        "bad signature": {"X-Internal-Assertion": f"{version}.{payload}.AAAA"},
        "expired": signed(path, iat=FIXED_NOW - timedelta(seconds=90)),
        "path mismatch": signed("/internal/admin/appointments?limit=1"),
    }
    for reason, headers in cases.items():
        resp, logs = await _refusal_logs(admin_client, path, headers)
        assert resp.status_code == 401, reason
        assert f"internal call refused: {reason}" in logs, reason
        assert '"code": "UNAUTHENTICATED"' in logs
        # Nothing taken from the request: not the email, the subject, the key or the header.
        for value in (OWNER, "sub-1", KEY, payload):
            assert value not in logs, (reason, value)


async def test_a_role_refusal_logs_why_without_the_email(
    admin_client: httpx.AsyncClient, signed: Signer
) -> None:
    path = "/internal/admin/appointments"
    resp, logs = await _refusal_logs(admin_client, path, signed(path, role="patient"))
    assert resp.status_code == 403
    assert "internal call refused: role not allowed for this endpoint" in logs
    assert '"code": "FORBIDDEN"' in logs
    assert OWNER not in logs

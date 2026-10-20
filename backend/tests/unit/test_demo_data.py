"""Locality audit of the demo cast: every name belongs to its community and gender, the cast is
varied, and the plan the seed would write is consistent. Pure: no database."""

from __future__ import annotations

from collections import Counter
from datetime import date

from app.scripts.demo_data import (
    AREAS,
    CANCEL_REASONS,
    COMMUNITY_FIRST,
    COMMUNITY_SURNAMES,
    PEOPLE,
)
from app.scripts.seed_demo import build_plan, phone

TODAY = date(2026, 10, 19)


def test_every_first_and_last_name_belongs_to_the_persons_community_and_gender() -> None:
    for p in PEOPLE:
        assert p.first in COMMUNITY_FIRST[p.community][p.gender], p.full_name
        assert p.last in COMMUNITY_SURNAMES[p.community], p.full_name


def test_no_name_is_shared_between_communities_or_genders() -> None:
    seen_first: dict[str, tuple[str, str]] = {}
    for community, by_gender in COMMUNITY_FIRST.items():
        for gender, names in by_gender.items():
            for n in names:
                assert n not in seen_first, f"{n} in {community}/{gender} and {seen_first[n]}"
                seen_first[n] = (community, gender)
    seen_last: dict[str, str] = {}
    for community, names in COMMUNITY_SURNAMES.items():
        for n in names:
            assert n not in seen_last, f"{n} in {community} and {seen_last[n]}"
            seen_last[n] = community
    assert not set(seen_first) & set(seen_last), "a name is used as both first name and surname"


def test_the_cast_is_unique_varied_and_local() -> None:
    assert len({p.full_name for p in PEOPLE}) == len(PEOPLE)
    assert len({p.email for p in PEOPLE}) == len(PEOPLE)
    assert {p.community for p in PEOPLE} == set(COMMUNITY_FIRST)
    assert {p.band for p in PEOPLE} == {"child", "teen", "adult", "senior"}
    assert {p.gender for p in PEOPLE} == {"F", "M"}
    assert {p.area for p in PEOPLE} <= set(AREAS)
    assert len({p.area for p in PEOPLE}) >= 10


def test_emails_can_never_reach_anyone_and_phones_are_clearly_fake() -> None:
    for i, p in enumerate(PEOPLE):
        assert p.email.endswith("@example.com")
        assert "'" not in p.email and " " not in p.email
        number = phone(i)
        assert number.startswith("+254700000") and len(number) == 13
    assert len({phone(i) for i in range(len(PEOPLE))}) == len(PEOPLE)


def test_cancellation_reasons_are_plain_and_area_reasons_name_real_areas() -> None:
    assert len(CANCEL_REASONS) >= 12
    for reason, areas in CANCEL_REASONS:
        assert 8 <= len(reason) <= 100 and "@" not in reason
        assert not any(c.isdigit() for c in reason)
        assert areas is None or set(areas) <= set(AREAS)


def test_every_doctor_sees_a_mix_of_communities_and_ages() -> None:
    plan = build_plan(TODAY)
    by_doctor: dict[str, list[str]] = {}
    for a in plan.appointments:
        by_doctor.setdefault(a.doctor_key, []).append(a.patient.key)
    assert set(by_doctor) == {"otieno", "kamau", "rotich", "mwangi", "njeri"}
    people = {p.key: p for p in PEOPLE}
    for doctor, keys in by_doctor.items():
        seen = [people[k] for k in set(keys)]
        assert len({p.community for p in seen}) >= 8, doctor
        if doctor == "mwangi":
            assert {p.gender for p in seen} == {"F"} and {p.band for p in seen} == {"adult"}
        else:
            assert {p.gender for p in seen} == {"F", "M"}, doctor
    kids = {people[k].band for k in by_doctor["kamau"]}
    assert kids <= {"child", "teen"}


def test_the_plan_is_deterministic_and_a_visit_never_repeats_a_patients_time() -> None:
    a, b = build_plan(TODAY), build_plan(TODAY)
    assert [x.id for x in a.appointments] == [x.id for x in b.appointments]
    assert a.events == b.events
    booked = Counter((x.patient.key, x.starts_at) for x in a.appointments if x.status == "booked")
    assert max(booked.values()) == 1
    slots = Counter((x.doctor_key, x.starts_at) for x in a.appointments if x.status == "booked")
    assert max(slots.values()) == 1


def test_history_is_older_than_the_relay_window_and_in_order() -> None:
    plan = build_plan(TODAY)
    for e in plan.events:
        assert plan.now - e.occurred_at >= __import__("datetime").timedelta(hours=1)
    for appt in plan.appointments:
        times = [e.occurred_at for e in appt.events]
        assert times == sorted(times) and len(set(times)) == len(times)


def test_today_and_the_next_two_weeks_are_busy_on_every_day_of_the_week() -> None:
    """Whatever day the seed is run on, the admin Today board has the doctors who work that day
    (visits later that day), Upcoming has visits for every doctor in the next 14 days, and the
    cancellation share stays about a tenth."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo

    from app.scripts.seed import DOCTORS

    tz = ZoneInfo("Africa/Nairobi")
    for offset in range(7):
        today = TODAY + timedelta(days=offset)
        plan = build_plan(today)
        booked = [a for a in plan.appointments if a.status == "booked"]
        todays = [a for a in booked if a.starts_at.astimezone(tz).date() == today]
        working = {
            d.key for d in DOCTORS if any(w.weekday == today.isoweekday() for w in d.windows)
        }
        assert {a.doctor_key for a in todays} == working, (today, working)
        assert all(a.starts_at >= plan.now for a in todays)  # not before the seed's own morning
        ahead = [a for a in booked if plan.now <= a.starts_at < plan.now + timedelta(days=14)]
        assert {a.doctor_key for a in ahead} == {d.key for d in DOCTORS}
        assert len(ahead) > 150
        cancelled = sum(1 for a in plan.appointments if a.status == "cancelled")
        assert 0.08 <= cancelled / len(plan.appointments) <= 0.12, (today, cancelled)

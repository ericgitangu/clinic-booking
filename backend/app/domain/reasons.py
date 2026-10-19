"""Group free-text cancellation reasons into the categories the dashboard charts.

One function, one ordered table. The first category with a matching keyword wins, so the order
below is the tie-break ("I was ill but feel better now" is `felt_better`, not `illness`). Matching
is on whole words or word starts, case-insensitive, so "sha" does not fire inside "shall".
"""

from __future__ import annotations

import re
from typing import Final, Literal

Category = Literal[
    "transport",
    "illness",
    "travel",
    "work",
    "weather",
    "felt_better",
    "insurance",
    "other",
]

CATEGORIES: Final[tuple[Category, ...]] = (
    "transport",
    "illness",
    "travel",
    "work",
    "weather",
    "felt_better",
    "insurance",
    "other",
)

# The admin app appends this to a reason typed by staff; it says nothing about why.
_STAFF_SUFFIX = re.compile(r"\(cancelled by clinic staff\)", re.IGNORECASE)

# Each pattern matches at a word start (\b), so "work" matches "working" and "worked".
_RULES: Final[tuple[tuple[Category, re.Pattern[str]], ...]] = (
    (
        "felt_better",
        re.compile(
            r"\b(feel(ing)?|felt|got|get(ting)?|am|is|are|much)\s+(much\s+)?better|"
            r"\bbetter now|\brecovered|\bno longer (need|require)|\bimproved|\bhealed|"
            r"\bwell again|\bsymptoms? (is|are)? ?gone",
            re.IGNORECASE,
        ),
    ),
    (
        "insurance",
        re.compile(
            r"\binsur|\bnhif\b|\bsha\b|\bmedical aid|\bcover(age)?\b|\bclaim|\bpre-?auth|"
            r"\bpayment|\bcould not afford|\bcan'?t afford|\bno money|\bfunds\b",
            re.IGNORECASE,
        ),
    ),
    (
        "weather",
        re.compile(r"\brain|\bflood|\bstorm|\bweather|\bthunder|\bmuddy", re.IGNORECASE),
    ),
    (
        "transport",
        re.compile(
            r"\btransport|\bmatatu|\bbus\b|\btraffic|\bjam\b|\bfare\b|\bride\b|\blift\b|"
            r"\bcar\b|\bvehicle|\btyre|\btire|\bboda|\btaxi|\buber|\bbolt\b|\bno way to get|"
            r"\bcan'?t get there|\bstrike",
            re.IGNORECASE,
        ),
    ),
    (
        "travel",
        re.compile(
            r"\btravel|\btrip\b|\bflight|\bout of town|\bout of (the )?country|\bupcountry|"
            r"\babroad|\bvacation|\bholiday|\bsafari|\bwedding|\bfuneral|\baway\b|"
            r"\bnot in (town|nairobi)|\bleaving (town|nairobi)",
            re.IGNORECASE,
        ),
    ),
    (
        "work",
        re.compile(
            r"\bwork|\bjob\b|\bmeeting|\bshift\b|\bboss|\boffice\b|\bdeadline|\binterview|"
            r"\bbusiness|\bclass\b|\bschool\b|\bexam",
            re.IGNORECASE,
        ),
    ),
    (
        "illness",
        re.compile(
            r"\bsick|\bill\b|\billness|\bunwell|\bfever|\bflu\b|\bcold\b|\bcovid|\bmalaria|"
            r"\bheadache|\bnausea|\bvomit|\bhospital|\badmitted|\binjur|\bpain|\bdiarrh|"
            r"\bcough|\bnot feeling well|\bfeeling (bad|worse|awful)|\bsurgery|\bin labou?r",
            re.IGNORECASE,
        ),
    ),
)


def classify_reason(reason: str | None) -> Category:
    """The category of a cancellation reason; `other` when nothing matches or none was given."""
    if reason is None:
        return "other"
    text = _STAFF_SUFFIX.sub(" ", reason).strip()
    if not text:
        return "other"
    for category, pattern in _RULES:
        if pattern.search(text):
            return category
    return "other"

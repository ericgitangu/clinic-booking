"""The curated demo cast: invented people, Nairobi-local, for ``app.scripts.seed_demo``.

Every name here is made up. People are listed one by one (no random first/last pairing), each
tagged with a community, a gender, an age band and the Nairobi area they live in, so a reviewer can
check each pairing by eye. ``COMMUNITY_FIRST`` and ``COMMUNITY_SURNAMES`` are the reference tables
the locality test checks every person against: the first name must belong to that community and
gender, the surname to that community, and no name may appear under two communities.

Names were chosen to be ordinary and plausible, not to match any well-known public figure. The
area is not stored in the database (the schema has no locality column and none is added); it only
shapes which cancellation reasons are plausible for the person.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Gender = Literal["F", "M"]
Band = Literal["child", "teen", "adult", "senior"]

COMMUNITY_FIRST: dict[str, dict[Gender, frozenset[str]]] = {
    "Kikuyu": {
        "F": frozenset({"Wanjiru", "Njeri", "Muthoni", "Wambui", "Nyambura", "Wangari"}),
        "M": frozenset({"Kamau", "Kimani", "Karanja", "Maina", "Githinji"}),
    },
    "Luo": {
        "F": frozenset({"Akinyi", "Atieno", "Awino", "Adhiambo", "Apiyo"}),
        "M": frozenset({"Ochieng", "Otieno", "Odhiambo", "Onyango", "Omondi"}),
    },
    "Luhya": {
        "F": frozenset({"Nafula", "Naliaka", "Nekesa", "Khasiani", "Namatsi"}),
        "M": frozenset({"Wafula", "Barasa", "Simiyu", "Wekesa", "Masinde"}),
    },
    "Kalenjin": {
        "F": frozenset({"Chepkoech", "Jelagat", "Cherono", "Jepkemoi"}),
        "M": frozenset({"Kiprono", "Kipchumba", "Kiplagat", "Kibet", "Kipkemboi"}),
    },
    "Kamba": {
        "F": frozenset({"Mwende", "Kalondu", "Nduku", "Syokau", "Mutheu"}),
        "M": frozenset({"Mutua", "Kioko", "Musyoka", "Mulwa", "Muthama"}),
    },
    "Kisii": {
        "F": frozenset({"Moraa", "Kemunto", "Nyaboke", "Bosibori"}),
        "M": frozenset({"Ontiri", "Ombati", "Mogaka", "Ondieki", "Omwoyo"}),
    },
    "Meru": {
        "F": frozenset({"Karimi", "Gakii", "Kanana", "Makena"}),
        "M": frozenset({"Kinoti", "Mutuma", "Murithi", "Kiambi"}),
    },
    "Mijikenda": {
        "F": frozenset({"Kadzo", "Mwanaisha", "Mwanajuma", "Karembo"}),
        "M": frozenset({"Katana", "Karisa", "Safari", "Ngowa", "Randu"}),
    },
    "Somali": {
        "F": frozenset({"Hodan", "Fartun", "Sagal", "Ladan", "Ayaan"}),
        "M": frozenset({"Abdullahi", "Mahad", "Ismail", "Yusuf", "Liban"}),
    },
    "Maasai": {
        "F": frozenset({"Naserian", "Resian", "Nashipae", "Naeku"}),
        "M": frozenset({"Parsaroi", "Saruni", "Lemayian", "Tipatet"}),
    },
    "Asian-Kenyan": {
        "F": frozenset({"Priya", "Farida", "Anjali", "Sakina", "Meera", "Nisha"}),
        "M": frozenset({"Rajesh", "Hitesh", "Sunil", "Kiran", "Jayesh"}),
    },
}

COMMUNITY_SURNAMES: dict[str, frozenset[str]] = {
    "Kikuyu": frozenset({"Gitau", "Mwaura", "Waweru", "Kariuki", "Njoroge", "Macharia", "Kabiru"}),
    "Luo": frozenset({"Owino", "Okoth", "Ouma", "Ogola", "Oloo", "Opiyo"}),
    "Luhya": frozenset({"Wamalwa", "Mukhwana", "Shitsama", "Wanyonyi", "Lusweti", "Sikuku"}),
    "Kalenjin": frozenset({"Langat", "Tuwei", "Maiyo", "Sang", "Bett", "Kirui"}),
    "Kamba": frozenset({"Mutinda", "Nzioka", "Kilonzo", "Maweu", "Musau", "Ndambuki"}),
    "Kisii": frozenset({"Nyakundi", "Onsongo", "Nyangau", "Mokaya", "Obino", "Ondimu"}),
    "Meru": frozenset({"Mwiti", "Gitonga", "Kirimi", "Riungu", "Mutegi"}),
    "Mijikenda": frozenset({"Mwadzame", "Kenga", "Chome", "Mwarandu", "Baya", "Tsuma", "Kalume"}),
    "Somali": frozenset({"Warsame", "Guled", "Mohamud", "Abdirahman", "Osman"}),
    "Maasai": frozenset({"Sempele", "Lekishon", "Kipury", "Ntoyian", "Kisemei"}),
    "Asian-Kenyan": frozenset({"Patel", "Shah", "Mehta", "Jivraj", "Varsani", "Pandya", "Lalji"}),
}

# Nairobi and surrounding areas the cast lives in. Used only to pick plausible cancellation
# reasons; never stored.
AREAS = (
    "Westlands",
    "Kilimani",
    "Kileleshwa",
    "South B",
    "South C",
    "Embakasi",
    "Kasarani",
    "Ruaka",
    "Karen",
    "Eastleigh",
    "Rongai",
    "Kitengela",
    "Thika Road",
)


@dataclass(frozen=True)
class Person:
    community: str
    gender: Gender
    band: Band
    first: str
    last: str
    area: str

    @property
    def full_name(self) -> str:
        return f"{self.first} {self.last}"

    @property
    def key(self) -> str:
        return f"{self.first}.{self.last}".lower()

    @property
    def email(self) -> str:
        """example.com is reserved for documentation (RFC 2606): no mail can ever reach anyone."""
        return f"{self.key}@example.com"


def _p(c: str, g: Gender, b: Band, first: str, last: str, area: str) -> Person:
    return Person(c, g, b, first, last, area)


PEOPLE: tuple[Person, ...] = (
    # Kikuyu
    _p("Kikuyu", "F", "adult", "Wanjiru", "Gitau", "Westlands"),
    _p("Kikuyu", "M", "adult", "Kimani", "Waweru", "Ruaka"),
    _p("Kikuyu", "F", "senior", "Muthoni", "Kabiru", "Kileleshwa"),
    _p("Kikuyu", "F", "child", "Njeri", "Macharia", "Thika Road"),
    _p("Kikuyu", "M", "teen", "Githinji", "Mwaura", "Kasarani"),
    # Luo
    _p("Luo", "F", "adult", "Akinyi", "Ogola", "South B"),
    _p("Luo", "M", "adult", "Ochieng", "Owino", "Embakasi"),
    _p("Luo", "F", "child", "Atieno", "Oloo", "South C"),
    _p("Luo", "M", "senior", "Omondi", "Okoth", "Eastleigh"),
    _p("Luo", "F", "adult", "Adhiambo", "Opiyo", "Kilimani"),
    # Luhya
    _p("Luhya", "F", "adult", "Nafula", "Wamalwa", "Rongai"),
    _p("Luhya", "M", "adult", "Wafula", "Mukhwana", "Kitengela"),
    _p("Luhya", "F", "teen", "Khasiani", "Sikuku", "Embakasi"),
    _p("Luhya", "M", "child", "Barasa", "Lusweti", "South B"),
    # Kalenjin
    _p("Kalenjin", "F", "adult", "Chepkoech", "Langat", "Karen"),
    _p("Kalenjin", "M", "adult", "Kiprono", "Tuwei", "Westlands"),
    _p("Kalenjin", "F", "senior", "Jelagat", "Maiyo", "Karen"),
    _p("Kalenjin", "M", "child", "Kibet", "Kirui", "Kilimani"),
    # Kamba
    _p("Kamba", "F", "adult", "Mwende", "Kilonzo", "Kitengela"),
    _p("Kamba", "M", "adult", "Mutua", "Nzioka", "Rongai"),
    _p("Kamba", "F", "child", "Nduku", "Mutinda", "Embakasi"),
    _p("Kamba", "M", "senior", "Musyoka", "Maweu", "South C"),
    # Kisii
    _p("Kisii", "F", "adult", "Moraa", "Onsongo", "Kileleshwa"),
    _p("Kisii", "M", "adult", "Ontiri", "Nyakundi", "Kasarani"),
    _p("Kisii", "F", "child", "Bosibori", "Mokaya", "Ruaka"),
    # Meru
    _p("Meru", "F", "adult", "Karimi", "Gitonga", "Thika Road"),
    _p("Meru", "M", "adult", "Kinoti", "Mwiti", "Westlands"),
    _p("Meru", "F", "teen", "Gakii", "Riungu", "Kasarani"),
    # Mijikenda
    _p("Mijikenda", "F", "adult", "Kadzo", "Mwarandu", "Eastleigh"),
    _p("Mijikenda", "M", "adult", "Katana", "Kenga", "South B"),
    _p("Mijikenda", "M", "child", "Karisa", "Chome", "Embakasi"),
    # Somali
    _p("Somali", "F", "adult", "Hodan", "Warsame", "Eastleigh"),
    _p("Somali", "M", "adult", "Mahad", "Guled", "Eastleigh"),
    _p("Somali", "F", "senior", "Fartun", "Mohamud", "South C"),
    # Maasai
    _p("Maasai", "F", "adult", "Naserian", "Sempele", "Kitengela"),
    _p("Maasai", "M", "adult", "Parsaroi", "Lekishon", "Rongai"),
    # Asian-Kenyan
    _p("Asian-Kenyan", "F", "adult", "Priya", "Shah", "Westlands"),
    _p("Asian-Kenyan", "M", "adult", "Rajesh", "Patel", "Kilimani"),
    _p("Asian-Kenyan", "F", "senior", "Farida", "Jivraj", "Westlands"),
    _p("Asian-Kenyan", "M", "adult", "Hitesh", "Mehta", "Kileleshwa"),
    _p("Asian-Kenyan", "F", "child", "Meera", "Varsani", "Karen"),
    _p("Asian-Kenyan", "M", "teen", "Sunil", "Pandya", "Ruaka"),
)


def _pick(options: list[str], *keys: object) -> str:
    import hashlib

    digest = hashlib.sha256("|".join(str(k) for k in keys).encode()).digest()
    return options[int.from_bytes(digest[:8], "big") % len(options)]


# Community shares of the extra, table-built people (rough Nairobi mix; a demo, not a census).
_WEIGHTS = (
    ("Kikuyu", 17), ("Luo", 12), ("Luhya", 12), ("Kalenjin", 10), ("Kamba", 10), ("Kisii", 6),
    ("Meru", 6), ("Mijikenda", 6), ("Somali", 7), ("Maasai", 3), ("Asian-Kenyan", 11),
)  # fmt: skip
_BANDS: tuple[Band, ...] = (
    "child", "child", "child", "child", "child", "child", "teen", "teen", "teen",
    "senior", "senior", "senior", "senior", "senior", "senior", "senior",
    "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult",
    "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult",
    "adult", "adult", "adult", "adult", "adult", "adult", "adult", "adult",
)  # fmt: skip
EXTRA_PEOPLE = 58


def _extend(base: tuple[Person, ...], extra: int) -> tuple[Person, ...]:
    """More people, built from the community tables with fixed hashes (so the cast never changes):
    a first name of the person's community and gender with a surname of the same community."""
    people = list(base)
    seen = {p.full_name for p in people}
    pool = [c for c, w in _WEIGHTS for _ in range(w)]
    n = 0
    while len(people) < len(base) + extra:
        n += 1
        community = _pick(pool, "community", n)
        gender: Gender = "F" if _pick(["F", "M", "F"], "gender", n) == "F" else "M"
        first = _pick(sorted(COMMUNITY_FIRST[community][gender]), "first", n)
        last = _pick(sorted(COMMUNITY_SURNAMES[community]), "last", n)
        if f"{first} {last}" in seen:
            continue
        seen.add(f"{first} {last}")
        band = _BANDS[int(_pick([str(i) for i in range(len(_BANDS))], "band", n))]
        people.append(Person(community, gender, band, first, last, _pick(list(AREAS), "area", n)))
    return tuple(people)


PEOPLE = _extend(PEOPLE, EXTRA_PEOPLE)

# Plain Kenyan English, no personal detail. ``areas`` limits a reason to people living there.
CANCEL_REASONS: tuple[tuple[str, tuple[str, ...] | None], ...] = (
    ("Matatu strike on Thika Road, will rebook", ("Thika Road", "Kasarani", "Ruaka")),
    ("Heavy rain, roads flooded in South B", ("South B", "South C")),
    ("Child unwell, staying home", None),
    ("Travelling upcountry for a funeral", None),
    ("Feeling better, no longer needed", None),
    ("Shift changed at work", None),
    ("Moving to Saturday when I'm off", None),
    ("Insurance pre-approval still pending", None),
    (
        "Heavy traffic on Mombasa Road, could not make it in time",
        ("Embakasi", "South B", "South C"),
    ),
    ("Matatus were not running, will book another day", ("Rongai", "Kitengela", "Embakasi")),
    ("Have to travel for work this week", None),
    ("Clashes with a school meeting, will pick another time", None),
    ("Roads flooded after last night's rain", ("Eastleigh", "Kasarani", "Ruaka")),
    ("Got a lift only on a different day, will rebook", ("Karen", "Rongai", "Kitengela")),
    ("Doctor at my insurer's hospital saw me already", None),
    ("Family visit got moved, will book another day", None),
)

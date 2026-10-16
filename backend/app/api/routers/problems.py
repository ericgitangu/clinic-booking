"""The problem catalogue endpoints (§6 rows 3-4)."""

from __future__ import annotations

from fastapi import APIRouter

from app.domain.errors import CATALOGUE, CATALOGUE_BY_CODE, DomainError
from app.schemas.problem import ProblemCode, ProblemEntry, problem_responses

router = APIRouter(tags=["problems"])


class ProblemNotFound(DomainError):
    code = "PROBLEM_NOT_FOUND"


def _entry(code: str) -> ProblemEntry:
    spec = CATALOGUE_BY_CODE[code]
    return ProblemEntry(
        code=ProblemCode(spec.code),
        slug=spec.slug,
        title=spec.title,
        status=spec.status,
        description=spec.description,
    )


@router.get("/problems", response_model=list[ProblemEntry])
async def list_problems() -> list[ProblemEntry]:
    return [_entry(spec.code) for spec in CATALOGUE]


@router.get("/problems/{slug}", response_model=ProblemEntry, responses=problem_responses(404))
async def get_problem(slug: str) -> ProblemEntry:
    for spec in CATALOGUE:
        if spec.slug == slug:
            return _entry(spec.code)
    raise ProblemNotFound(f"no problem with slug '{slug}'")

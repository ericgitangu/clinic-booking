"""The release pipeline's own door: create a patient that the admin views will ignore.

``scripts/verify_claims.py`` books and cancels real rows in the production database on every
release. It creates its patients here, signed with ``SMOKE_SIGNING_KEY``, so they are stored with
``synthetic = true``. The public ``POST /patients`` cannot do this: its body forbids extra fields
and it always stores ``false``. Not part of the published contract (``include_in_schema=False``):
no generated client should ever offer it.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session, require_smoke
from app.schemas.patient import Patient, PatientCreate
from app.services.patients import create_patient

router = APIRouter(prefix="/internal/smoke", include_in_schema=False)


@router.post(
    "/patients", response_model=Patient, status_code=201, dependencies=[Depends(require_smoke)]
)
async def post_synthetic_patient(
    body: PatientCreate,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> Patient:
    patient = await create_patient(session, body, synthetic=True)
    response.headers["Location"] = f"/patients/{patient.id}"
    response.headers["Cache-Control"] = "no-store"
    return Patient.model_validate(patient)

"""patient_accounts: the link between a sign-in and a patient. The runtime role can only insert."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_GET = text("SELECT patient_id FROM patient_accounts WHERE google_sub = :sub")

# ON CONFLICT DO NOTHING, so two first sign-ins racing for the same person leave one row; the
# loser reads the winner's row afterwards.
_INSERT = text(
    """
    INSERT INTO patient_accounts (google_sub, patient_id, email, image_url)
    VALUES (:sub, :patient_id, :email, :url)
    ON CONFLICT (google_sub) DO NOTHING
    RETURNING patient_id
    """
)


_SET_IMAGE = text(
    """
    UPDATE patient_accounts SET image_url = :url
    WHERE google_sub = :sub AND image_url IS DISTINCT FROM :url
    """
)


async def set_image(session: AsyncSession, *, sub: str, url: str | None) -> None:
    """Follow the person's current picture (null clears it). A no-op when nothing changed."""
    await session.execute(_SET_IMAGE, {"sub": sub, "url": url})


async def patient_id_for(session: AsyncSession, sub: str) -> uuid.UUID | None:
    return (await session.execute(_GET, {"sub": sub})).scalar_one_or_none()


async def insert_link(
    session: AsyncSession, *, sub: str, patient_id: uuid.UUID, email: str, url: str | None = None
) -> uuid.UUID | None:
    """The patient id when this call created the link, None when the sub was already linked."""
    return (
        await session.execute(
            _INSERT, {"sub": sub, "patient_id": patient_id, "email": email, "url": url}
        )
    ).scalar_one_or_none()

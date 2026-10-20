"""The doctor's address is staff-only: no public path or public schema carries it."""

from __future__ import annotations

import json
import pathlib


def test_the_public_contract_has_no_doctor_email() -> None:

    spec = json.loads(
        (pathlib.Path(__file__).resolve().parents[3] / "contracts" / "openapi.json").read_text()
    )
    schemas = spec["components"]["schemas"]
    for name in ("Doctor", "DoctorList", "Appointment", "AvailabilityResponse"):
        if name in schemas:
            assert "email" not in schemas[name].get("properties", {}), name
    public_paths = [p for p in spec["paths"] if not p.startswith("/internal")]
    blob = json.dumps({p: spec["paths"][p] for p in public_paths})
    assert "doctor_email" not in blob and "DoctorEmail" not in blob
    assert "DoctorBoard" not in blob

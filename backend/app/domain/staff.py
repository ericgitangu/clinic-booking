"""What a staff write carries into the booking service.

Passing one makes the call a staff call: exempt from the lead-time rules, bound by every other
invariant, recorded as ``actor = 'staff'`` on the lifecycle event, and written to
``staff_action_audit`` in the same transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

StaffActionName = Literal[
    "book",
    "reschedule",
    "cancel",
    "veto",
    "unlock",
    "arrived",
    "no_show",
    "reminder_now",
    "running_late",
    "invite_create",
    "invite_revoke",
    "invite_accept",
    "doctor_email",
]


@dataclass
class StaffAction:
    action: StaffActionName
    actor_email: str
    actor_role: str
    reason: str
    # A veto sets the lock in the same transaction as the reversal.
    lock: bool = False
    # Whether this write skips the one-hour (lead-time) rule. Follows STAFF_CRUD_ENABLED: with the
    # switch off, staff on the existing routes are held to exactly the patient rules.
    lead_exempt: bool = True
    # Outputs, filled by the service inside the transaction: the audit row (None when the call
    # changed nothing, so wrote nothing) and the start the appointment had before a move or cancel.
    audit_id: uuid.UUID | None = None
    previous_starts_at: datetime | None = None
    # An arrival writes the record of telling the doctor in the same transaction (None otherwise).
    doctor_notice: Any = None


def is_vetoable(event_type: str | None, actor: str | None, has_successor: bool) -> bool:
    """Whether the latest change of an appointment can be vetoed: it was recorded as the
    patient's, it is not the first booking, and staff have not already booked a replacement. A NULL
    actor is an event from before actors were recorded: it cannot be shown to be the patient's, so
    it is left alone. The veto action and the Today board's ``patient_changed`` both call this."""
    return (
        event_type is not None
        and actor == "patient"
        and event_type != "booked"
        and not has_successor
    )

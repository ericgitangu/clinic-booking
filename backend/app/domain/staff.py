"""What a staff write carries into the booking service.

Passing one makes the call a staff call: exempt from the lead-time rules, bound by every other
invariant, recorded as ``actor = 'staff'`` on the lifecycle event, and written to
``staff_action_audit`` in the same transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

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
]


@dataclass
class StaffAction:
    action: StaffActionName
    actor_email: str
    actor_role: str
    reason: str
    # A veto sets the lock in the same transaction as the reversal.
    lock: bool = False
    # Outputs, filled by the service inside the transaction: the audit row (None when the call
    # changed nothing, so wrote nothing) and the start the appointment had before a move or cancel.
    audit_id: uuid.UUID | None = None
    previous_starts_at: datetime | None = None

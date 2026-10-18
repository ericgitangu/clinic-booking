# ADR-0033: Staff appointment CRUD, patient-change veto and email invites

- Date: 2026-10-18
- Deciders: engineering, decided by the engineer after an architect review
- Amends: [ADR-0030](0030-staff-roles-and-access.md), [ADR-0008](0008-appointment-lifecycle-and-reschedule.md)

## Status

Accepted, decided by the engineer 2026-10-18.

**Build status (2026-10-18, main 2bbfa61): Declared, not built.** None of this code is merged. The backend (migration, routes, audit table, invite flow), the admin screens and the five email templates are three separate pull requests that have not landed. Until they do, `staff_access_audit` is the only audit table and a staff cancel or reschedule still records no actor. Each section below describes the decision, not the running system.

## Context

- Staff can already cancel and reschedule for a patient ([ADR-0030](0030-staff-roles-and-access.md)). `cancel_for_patient` and `reschedule_for_patient` in `admin.py` never record which staff member acted, and the only audit table covers access changes. If a patient disputes a change, nobody can say who made it or why.
- Staff cannot create an appointment for a patient, and a patient can undo what staff did. There is no way for the clinic to say "this booking is settled, stop changing it".
- Access is granted by the owner typing an email on the Access page. The person has to be told out of band, and an admin cannot bring in a viewer without the owner.
- The staff are bound by the same lead-time rules as patients, so a front desk cannot fix a booking that starts in 40 minutes. Those rules protect the clinic from patients, not from itself.
- The email path already exists with daily and monthly caps ([ADR-0025](0025-email-with-resend.md)); a patient told of a change by staff has to come out of the same caps.

## Considered options

1. Extend the existing admin services: staff create, reschedule and cancel through the same service functions with a `staff` flag, every write needs a reason and writes an append-only audit row in the same transaction, a veto reverses the patient's last change and locks the lineage, and invites are single-use hashed tokens bound to a Google email. Chosen.
2. Staff edit in place with a plain UPDATE and no audit or veto. Smallest change, but it repeats the gap this ADR exists to close: no actor, no reason, no way to stop a patient reversing the change.
3. A separate staff-write API with its own booking logic, outside the existing services. Staff rules would not drift into the patient path, but the slot, working-hours and double-booking rules would exist twice, and the second copy is where the bug would be.
4. Invitations by allowlist edit only: the owner keeps typing emails and tells people by hand. No new tables, but no expiry, no consent from the invitee, and an admin still cannot bring in a viewer.

## Decision

Option 1.

- **Veto.** A veto reverses the patient's most recent change using existing actions, then sets `appointments.staff_locked_at`. A cancel is undone by staff re-booking the same slot as a new appointment linked by lineage. A reschedule is undone by moving it back to its `from_starts_at`. After that, any patient book, cancel or reschedule on that lineage gets 409 `APPOINTMENT_LOCKED`. An admin can unlock. The lock follows reschedules. The reason is mandatory, 3 to 500 characters. If there is no patient change to reverse the answer is 409 `NOTHING_TO_VETO`.
- **Staff and the booking rules.** Staff are exempt from the lead-time rules (`BOOKING_TOO_SOON`, `CHANGE_TOO_LATE`) and bound by the invariants: `SLOT_IN_PAST`, `APPOINTMENT_ALREADY_STARTED`, `SLOT_TAKEN`, `PATIENT_DOUBLE_BOOKED` and working hours. The exemption is a `staff` flag on the existing service functions, not a second implementation. Every staff write requires a reason.
- **Create.** Staff create an appointment for an existing patient id, or with new patient details.
- **Audit.** A new append-only `staff_action_audit` table: `actor_email`, `actor_role`, `action`, `appointment_id`, `reason`, `before` and `after` as jsonb with no patient name, phone or email, `notified`, `occurred_at`. It is written in the same transaction as the change. The `clinic_app` role gets SELECT and INSERT only. `appointment_events.actor` becomes nullable, `patient` or `staff`.
- **Visibility is chosen by the API per role, never by the UI.** Owner and admin see full patient data. A viewer gets initials and a masked phone, no email and no reason text.
- **Invites.** A `staff_invites` table: `email` citext, `role` with a CHECK in (`admin`, `viewer`), `token_hash` (sha256), `invited_by`, `expires_at` (72 hours after creation), `consumed_at`, `revoked_at`. A partial unique index allows one open invite per email, and inviting again supersedes the open one. The raw 32-byte token exists only in the email link. Accepting needs a Google session whose verified email equals the invite email, compared in constant time. Every failure (unknown, reused, expired, revoked, email mismatch) returns 404 `INVITE_INVALID` with an identical body. Accepting upserts `staff_access` and consumes the invite in one transaction. Invites are rate limited at 10 per actor per day (`RATE_LIMITED`).
- **Patients are told.** Staff book, reschedule, cancel and veto each email the patient with the reason. The Resend `Idempotency-Key` is the audit row id, and sends count against the existing caps. If the cap is hit nothing is sent and `notified` is false.
- **No patient or token values in logs.** Only hashes and ids.

### Permission matrix

| Action | Owner | Admin | Viewer |
|---|---|---|---|
| View appointments | Full PII | Full PII | Minimised (initials, masked phone, no email, no reason) |
| Create, reschedule, cancel | Yes | Yes | No (403) |
| Veto, lock, unlock | Yes | Yes | No (403) |
| Invite an admin or a viewer | Yes | Yes | No (403) |
| Change or revoke a viewer | Yes | Yes | No (403) |
| Change or revoke an admin | Yes | No (`ROLE_ESCALATION`) | No (403) |
| Revoke an open invite | Yes | Yes | No (403) |
| Read the audit trail | Yes | Yes | No (403) |
| Lead-time exemption | Yes | Yes | Not applicable |
| Grant owner, or act on the owner | Nobody (`OWNER_PROTECTED`) | Nobody (`OWNER_PROTECTED`) | Nobody (`OWNER_PROTECTED`) |
| Change your own row | No (`ROLE_ESCALATION`) | No (`ROLE_ESCALATION`) | No (`ROLE_ESCALATION`) |

### New codes

`ROLE_ESCALATION` (403), `APPOINTMENT_LOCKED` (409), `NOTHING_TO_VETO` (409) and `INVITE_INVALID` (404) are new. `ACCESS_EXISTS` (409) and `OWNER_PROTECTED` (409) are already in the catalogue from [ADR-0030](0030-staff-roles-and-access.md) and are reused. The meanings are in [the error catalogue](../api-errors.md).

### Rollback

`STAFF_CRUD_ENABLED=false` turns the new routes off. The schema change is additive (a nullable column, a nullable actor, two new tables and grants), so turning the flag off leaves existing data and the older cancel and reschedule paths as they are.

## Consequences

- Good: every staff write has an actor, a reason and a before and after, in the same transaction as the change, and the application role cannot edit or delete the trail.
- Good: staff fix near-term bookings without a second copy of the booking rules.
- Good: the clinic can freeze a booking against further patient changes, and an admin can undo that.
- Good: an invite is useless to anyone but the invitee's Google account, and it reveals nothing about whether an email was ever invited.
- Bad: a veto of a cancel gives the booking a new appointment id. Anything keyed on the old id sees a cancelled appointment and a new one, linked only by lineage.
- Bad: the audit before and after leave out patient fields on purpose, so the trail says what changed in the schedule but not the patient details.
- Bad: admins can now bring in viewers without the owner. That is a wider grant than [ADR-0030](0030-staff-roles-and-access.md) allowed, bounded by the rules in the matrix.
- Bad: patient email is best-effort and a bounced or capped email is only visible as `notified = false`.

### Declared debt

- **Patient email has no retry.** It is sent best-effort after the response, with no outbox. If the process dies after the commit, or the provider fails, the patient is not told and `notified` stays false. Risk: a patient learns of a staff change when they next look. The real fix is the outbox pattern the realtime relay already uses (`0006_realtime_outbox`, [ADR-0031](0031-realtime-push-via-ably-sse.md)): write the email intent in the same transaction and send from a relay. Not built in this ADR to keep the first version small.
- **An undone cancel gets a new appointment id.** The lineage link is the only join. The real fix is to reopen the cancelled row, which the partial unique index and the lifecycle in [ADR-0008](0008-appointment-lifecycle-and-reschedule.md) do not allow today.

## Assessment line

Section 1 "key decisions, trade-offs": who may change a patient's appointment, how the clinic can hold a booking against the patient, and how that is recorded.

## Review trigger

Per-clinic scoping (roles and invites are global to the single clinic), a second owner, email volume near the caps, or patient consent before staff changes. Then revisit the invite rules, the notification path and the outbox debt first.

**Note (2026-10-19): the one-hour rule.** [ADR-0008](0008-appointment-lifecycle-and-reschedule.md) now refuses a cancel, or a reschedule of a visit under 60 minutes away (`409 CHANGE_TOO_LATE`), for staff too. Any staff exemption from that rule lands with the staff-write work described here, together with its audit record; until then staff follow the rule.

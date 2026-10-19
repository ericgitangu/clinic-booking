# ADR-0033: Staff appointment CRUD, patient-change veto and email invites

- Date: 2026-10-18
- Deciders: engineering, decided by the engineer after an architect review
- Amends: [ADR-0030](0030-staff-roles-and-access.md), [ADR-0008](0008-appointment-lifecycle-and-reschedule.md)

## Status

Accepted, decided by the engineer 2026-10-18.

**Build status (2026-10-19): built in the API, screens and emails pending.** The backend (migrations 0009 and 0010, routes, audit table, invite flow, attendance, the operations read model) is pull request #63. The admin screens and the email templates are separate pull requests that may not have landed; check them before relying on those parts. The text below was written first; where building it changed a decision, the dated amendment further down says so. Before the backend landed (2026-10-18, main 2bbfa61) this ADR was declared, not built. At that time the backend, the admin screens and the email templates were three separate pull requests that had not landed, `staff_access_audit` was the only audit table, and a staff cancel or reschedule recorded no actor. The sections below describe the decision; the dated amendment says where building it changed that.

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
| Invite a viewer (a new address) | Yes | Yes | No (403) |
| Invite an address whose access was revoked | Yes | No (`ROLE_ESCALATION`) | No (403) |
| Invite an admin | Yes | No (`ROLE_ESCALATION`) | No (403) |
| Change or revoke a viewer | Yes | Yes | No (403) |
| Change or revoke an admin | Yes | No (`ROLE_ESCALATION`) | No (403) |
| Revoke an open invite to be a viewer | Yes | Yes | No (403) |
| Revoke an open invite to be an admin | Yes | No (`ROLE_ESCALATION`) | No (403) |
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

**Rollback note (2026-10-19, additive).** With `STAFF_CRUD_ENABLED=false` the unlock route is off too, so visits that staff already locked stay locked for patients. Unlock them before switching off, or clear the column as the owner role in a transaction after counting the rows (`SELECT count(*) FROM appointments WHERE staff_locked_at IS NOT NULL;`, then `UPDATE appointments SET staff_locked_at = NULL WHERE staff_locked_at IS NOT NULL;` and compare the row count). The audit table is not touched. The exact steps are in [the rollback runbook](../runbooks/rollback.md).

### Declared debt

- **Patient email has no retry.** It is sent best-effort after the response, with no outbox. If the process dies after the commit, or the provider fails, the patient is not told and `notified` stays false. Risk: a patient learns of a staff change when they next look. The real fix is the outbox pattern the realtime relay already uses (`0006_realtime_outbox`, [ADR-0031](0031-realtime-push-via-ably-sse.md)): write the email intent in the same transaction and send from a relay. Not built in this ADR to keep the first version small.
- **An undone cancel gets a new appointment id.** The lineage link is the only join. The real fix is to reopen the cancelled row, which the partial unique index and the lifecycle in [ADR-0008](0008-appointment-lifecycle-and-reschedule.md) do not allow today.

### Amendment, 2026-10-19 (decisions made while building)

These refine the text above; nothing above is removed.

- **Audit grants.** The runtime role has SELECT and INSERT on `staff_action_audit` and one column grant, `UPDATE (notified)`, because the patient email goes out after the response. A trigger lets `notified` move from false to true only, never back, and only on a row whose action emails the patient and whose outcome was not recorded as "demo, not sent" or "no email on file". Every other UPDATE and every DELETE is refused by privilege. The API lets only the person who made the action mark it; anyone else gets the same 404 as an unknown id.
- **Admin to admin.** An admin cannot make someone an admin by changing their row, and cannot invite an admin either: admin-role invitations are the owner's to send. This also means an admin cannot bring back an admin the owner revoked. The owner can; an admin invites viewers only.
- **Verified email.** Every staff route requires the signed assertion to carry a verified email, not only the invite accept.
- **Synthetic patients.** Staff writes and patient notifications treat the release smoke's synthetic patients as not found.
- **No-show and arrival windows.** Arrival can be recorded from 15 minutes before the start to 2 hours after it; no-show from the start to 2 hours after.
- **Vetoes.** Only a change recorded as the patient's can be vetoed. An event from before actors were recorded (a NULL actor) cannot be shown to be the patient's, so it is left alone and the answer is `NOTHING_TO_VETO`. A patient trying to take back the slot of a vetoed cancel gets `APPOINTMENT_LOCKED`. When two vetoes race, or a veto races a staff re-booking of the same slot, the loser is told `NOTHING_TO_VETO`, never `SLOT_TAKEN`.
- **Invite emails** are compared after Unicode NFKC and case folding, at creation and at accept. Accept attempts are limited to 20 per person per day (`RATE_LIMITED`), counted whether or not they succeed; the invalid-invite body is unchanged.
- **Who granted.** After a role change, `granted_by` and `granted_at` name the person who made the change and when; the full history is in `staff_access_audit`.
- **Revoked access stays revoked.** An address whose access was revoked can be invited again only by the owner, at any role. An admin invites new addresses as viewers. Revoking an invitation to be an admin is also the owner's; an admin revokes invitations to be a viewer.
- **The switch covers the exemption.** With `STAFF_CRUD_ENABLED=false`, staff using the existing cancel and reschedule routes are held to the patient rules exactly (`CHANGE_TOO_LATE`, `BOOKING_TOO_SOON`); the lead-time exemption exists only while the switch is on. An unverified identity cannot spend a person's accept attempts: it is refused before it is counted.
- **What the audit trigger is for.** The check that only the actor can set `notified` stops mistakes and unscoped writers. It reads a transaction-local setting that any runtime session could set, so it is not a defence against a compromised runtime role.
- **Migrations edited before merge.** Migrations 0009 and 0010 were changed in place while unmerged; no persistent database has applied them, so a preview database that already did needs to be recreated or downgraded and upgraded.
- **Invitations are audited.** Creating and revoking an invitation (including one superseded by a new invitation) each write a `staff_action_audit` row in the same transaction (`invite_create`, `invite_revoke`), with an id, the role and a SHA-256 of the address, never the address. The create response carries `audit_id`, `deliver` and `outcome`. The web app emails the link `/invite/<token>` when `deliver` is true and then marks the row notified; a reserved example address is recorded as "demo, not sent" and nothing is sent.
- **Downgrade.** Both migrations refuse to downgrade while the audit trail, invitations, attendance marks or annotation events exist, so append-only data is never dropped by a rollback.

## Assessment line

Section 1 "key decisions, trade-offs": who may change a patient's appointment, how the clinic can hold a booking against the patient, and how that is recorded.

## Review trigger

Per-clinic scoping (roles and invites are global to the single clinic), a second owner, email volume near the caps, or patient consent before staff changes. Then revisit the invite rules, the notification path and the outbox debt first.

**Note (2026-10-19): the one-hour rule.** [ADR-0008](0008-appointment-lifecycle-and-reschedule.md) refuses a cancel, or a reschedule of a visit under 60 minutes away (`409 CHANGE_TOO_LATE`), and a booking or a reschedule's new start under 60 minutes (`422 BOOKING_TOO_SOON`). Staff are exempt from both: the exemption is built (a staff flag on the same service functions), and it is the only rule staff are exempt from. Staff stay bound by `SLOT_IN_PAST`, `APPOINTMENT_ALREADY_STARTED`, `APPOINTMENT_ALREADY_CANCELLED`, `DATE_OUT_OF_RANGE`, `SLOT_MISALIGNED`, `OUTSIDE_WORKING_HOURS`, `SLOT_TAKEN` and `PATIENT_DOUBLE_BOOKED`.

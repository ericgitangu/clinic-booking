# ADR-0025: Booking emails and reminders with Resend

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer

## Status

Accepted. Implemented 2026-10-18 with the changes listed under "As built". Patients get an email when they book, reschedule or cancel, and a reminder the evening before.

## Context

- A booking you cannot find later is half a feature. Emails also show the system doing work after the request ends.
- It must stay at $0 and must not put a secret in the repository.
- The sender is `reminders@ericgitangu.com`, reply-to `developer.ericgitangu@gmail.com`. The engineer reports that the domain is already verified in Resend (2026-10-17).

## Considered options

1. No email.
2. Resend, with React Email templates, sent from the web app's server side.
3. Send from Cloud Run. It would need an outbound address and the secret on a second service.
4. A different provider. Nothing gained over Resend's free tier.

## Decision

Option 2.

- **Provider limits (Free plan):** 3,000 emails a month, 100 a day, 3 custom domains, 30-day log retention (<https://resend.com/pricing>, read 2026-10-17).
- **Templates:** React Email, bespoke and branded ([ADR-0026](0026-branding-and-seo.md)), passed to the SDK as `react: <Email />` (<https://react.email/docs/integrations/resend>). Plain-text versions are generated too.
- **Acknowledgements** (booked, rescheduled, cancelled) are sent by the BFF right after the API call succeeds, with an idempotency key `ack/<appointment_id>/<event_id>`. A failed send is logged and never fails the booking.
- **The daily cap counts everything.** Acknowledgements are sent first because they are sent inline. The reminder run is capped at 50 emails, which leaves at least 50 of the 100 for acknowledgements. If Resend still refuses with a quota error, the email is dropped and logged, never queued past the day.
- **Reminder schedule.** One Vercel Cron job at `0 15 * * *`, which is 15:00 UTC, 18:00 in Nairobi (EAT, UTC+3, no daylight saving). Hobby cron runs once a day with hourly precision, so a run lands between 15:00 and 15:59 UTC, 18:00 and 18:59 local (<https://vercel.com/docs/cron-jobs/usage-and-pricing>, read 2026-10-17). A run reminds every booked appointment whose clinic-local date is tomorrow. A booking made for the same day, or after that evening's run for the next day, gets the acknowledgement only and no reminder.
- **Delivery is at least once, and a reminder must not be lost or sent twice.** Two new nullable columns on `appointments` (an expand-only migration): `reminder_claimed_at` and `reminder_sent_at`.
  1. The cron route (`/cron/reminders`, outside `/api`, protected by `CRON_SECRET`) calls `POST /internal/reminders/claim?limit=50`. One statement claims due rows: `UPDATE appointments SET reminder_claimed_at = now() WHERE id IN (SELECT id FROM appointments WHERE status = 'booked' AND reminder_sent_at IS NULL AND (reminder_claimed_at IS NULL OR reminder_claimed_at < now() - interval '15 minutes') AND starts_at >= :tomorrow_start AND starts_at < :tomorrow_end ORDER BY starts_at LIMIT :n FOR UPDATE SKIP LOCKED) RETURNING ...`. A claim is a 15-minute lease.
  2. The BFF sends each reminder with the Resend idempotency key `reminder/<appointment_id>/<starts_at epoch>` (keys are 1 to 256 characters, kept 24 hours; a repeat with the same payload returns the original result instead of sending again; <https://resend.com/docs/dashboard/emails/idempotency-keys>).
  3. Only after Resend answers 2xx does the BFF call `POST /internal/reminders/<id>/sent`, which sets `reminder_sent_at`. A failure leaves the row claimed; the lease expires and a later run takes it again while the appointment is still ahead (see "As built": the run retries a passing failure itself, and tomorrow's run covers everything still to come).
  4. If Vercel delivers the cron event twice, the second run skips rows under an active lease or already sent, and the idempotency key covers the narrow race where both reach Resend.
  5. Rescheduling clears both columns in the same transaction, so the new time gets its own reminder (and a new idempotency key, because the start time is part of it). Cancelling makes the row ineligible.
- **Secrets:** `RESEND_API_KEY` goes into Vercel environment variables (sensitive) and nowhere else: the BFF sends the mail, so Secret Manager would only add a version, and the key is never written to a file or the repository.

## Consequences

- Good: bookings leave a trace the patient can find, and reminders show scheduled work.
- Good: $0 within the free limits; the cron is part of the Hobby plan.
- Good: no reminder is lost to a crash or sent twice to a double delivery.
- Bad: reminders arrive up to 59 minutes after 18:00, and at most 50 go out a day, so a clinic with more would need a paid plan.
- Bad: delivery is at least once, so a very unlucky crash between Resend accepting and the `sent` call can repeat a reminder after the 24-hour idempotency window, which a 15-minute lease makes practically impossible.

## As built

- **Acknowledgement key:** `ack/<appointment_id>/<kind>/<updated_at in ms>`. The API's responses do not carry an event id, and `updated_at` moves on every change, so a repeat of one request returns the first result and the next change gets a new key.
- **The daily limit is counted in the database.** A table `email_counter(day, sent)` (UTC day) is increased by the API each time the web app reports an email Resend accepted (`POST /internal/emails/record`), and read with `GET /internal/emails/today`. Acknowledgements check it before sending and are dropped and logged when it is used up. The reminder claim is limited to the smaller of 50 and what is left of the day, so acknowledgements already sent are never crowded out.
- **The claim is one statement** with `FOR UPDATE SKIP LOCKED`, takes only booked appointments whose patient has an email, and uses the API's clock for the lease, so it can be tested without waiting. The run signs as a system caller (role `system`, subject `system:reminders`), which only the reminder routes accept.
- **`?on=YYYY-MM-DD`** on the cron route and on the claim reminds for that clinic-local date instead of tomorrow (a rehearsal or a re-run), for whoever holds `CRON_SECRET`; today and past dates are refused.
- **Who is emailed.** Only patients with a linked, verified Google account, at the address the account was linked with. The public `POST /patients` takes any address, unverified, so emailing those would let anyone make `reminders@ericgitangu.com` mail strangers and use up the day's limit: reminders are never claimed for such patients, and acknowledgements go only to the signed-in person's own verified address. A test shows an API-created patient with an email gets nothing.
- **Retries.** A send that fails for a passing reason (Resend 429 or 5xx, or unreachable) is retried inside the run, twice, after 300 ms and 900 ms, with the same idempotency key (so a try that did reach Resend is not sent twice), and at most 20 retries in a whole run. A 4xx is not retried. What still fails stays claimed under its lease. A run covers every unsent appointment still ahead up to the end of tomorrow (not only tomorrow), so a reminder that failed on one run is picked up again by the next run that happens while the appointment is still to come. Once an appointment has started it is no longer reminded.
- **"Sent" is tied to the claim.** The run reports a reminder as sent quoting the claim time and start time it was sent under, and the API marks it only if both still match. If the patient moved the appointment while the email was in flight, the stale report marks nothing and the new time is reminded.
- **Room for acknowledgements.** A reminder run leaves `EMAIL_ACK_RESERVE` (20) of the day's 100 unclaimed, logs when the budget cut a claim short, and an acknowledgement is dropped (and logged) when the budget cannot be read at all, so a broken counter cannot become unlimited email.
- **Tests** run against the real API, database and app. The one stand-in is Resend's HTTP API (`e2e/support/resend-standin.mjs`), which the real Resend SDK is pointed at with `RESEND_BASE_URL`; it checks the key, applies Resend's idempotency rules and can refuse one recipient's mail. It is labelled as a stand-in wherever it appears.

## Assessment line

"Patients can cancel": they receive a confirmation of the cancellation, and of every other change.

## Review trigger

More than about 50 appointments needing a reminder in a day, a need for reminders at a precise time (a paid Vercel plan), or the sender domain being flagged as spam, which would move sending to a subdomain as Resend recommends.

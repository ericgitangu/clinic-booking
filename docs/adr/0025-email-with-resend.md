# ADR-0025: Booking emails and reminders with Resend

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer

## Status

Accepted. Patients get an email when they book, reschedule or cancel, and a reminder before the appointment.

## Context

- A booking you cannot find later is half a feature. Emails also show the system doing work after the request ends.
- It must stay at $0 and must not put a secret in the repository.
- The sender address is `reminders@ericgitangu.com`, reply-to `developer.ericgitangu@gmail.com`.

## Considered options

1. No email.
2. Resend, with React Email templates, sent from the web app's server side.
3. Send from Cloud Run. It would need an outbound address and the secret on a second service.
4. A different provider. Nothing gained over Resend's free tier.

## Decision

Option 2.

- **Provider limits (Free plan):** 3,000 emails a month, 100 a day, 3 custom domains, 30-day log retention (<https://resend.com/pricing>, read 2026-10-17). The daily cap is the one that matters: a reminder run is capped at 80 emails and anything left waits for the next day. Acknowledgements are sent first.
- **Templates:** React Email, bespoke and branded (ADR-0026), passed straight to the SDK as `react: <Email />` (<https://react.email/docs/integrations/resend>). Plain-text alternatives are generated as well.
- **When:** booking, reschedule and cancel notices are sent by the BFF right after the API call succeeds. A failed send is logged and never fails the booking.
- **Reminders:** a daily Vercel Cron calls a BFF route; the route asks the API for the appointments due in the next 24 hours that have not been reminded (`POST /internal/reminders/due`, which marks them with a new nullable `reminder_sent_at` column, an expand-only migration), sends them, and reports back. Vercel Hobby allows cron jobs once per day with hourly precision, so a run lands anywhere in its scheduled hour (<https://vercel.com/docs/cron-jobs/usage-and-pricing>, read 2026-10-17). The cron route lives outside `/api` (`/cron/reminders`), is protected by `CRON_SECRET`, and calls the API through the same IAM-gated path as everything else.
- **Domain:** `ericgitangu.com` is not on Vercel DNS. Its name servers are Google's (`ns-cloud-a1..a4.googledomains.com`, observed with `dig` on 2026-10-17), so the Resend records cannot be added with the Vercel CLI; they go into the zone at that provider by hand. Resend recommends sending from a subdomain to keep reputation separate; the chosen address is on the root domain, so a subdomain is the fallback if deliverability suffers.
- **Secrets:** `RESEND_API_KEY` goes into Vercel environment variables (sensitive) and one Secret Manager secret as the backup copy, never into a file or the repository.

## Consequences

- Good: bookings leave a trace the patient can find, and reminders show scheduled work.
- Good: $0 within the free limits; the cron is part of the Hobby plan.
- Bad: reminders may arrive up to 59 minutes after the scheduled time, and no more than 100 emails a day can go out.
- Bad: one more Secret Manager version, about $0.06 a month on the shared account (ADR-0014).
- Bad: DNS is set up by hand outside Vercel. Until the domain is verified, emails cannot be sent from it.

## Assessment line

"Patients can cancel": they receive a confirmation of the cancellation, and of every other change.

## Review trigger

More than about 80 appointments needing a reminder in a day, a need for same-hour reminders (a paid plan), or the sender domain being flagged as spam.

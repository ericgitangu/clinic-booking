// The cards for decisions 25 to 34. Every concrete figure here was checked against the code
// on main (config defaults, the CI config, the migrations, the apps). Where a card describes more
// than main has, the card says what main has.
import type { DecisionCard } from "./types";

export const DECISION_INTRO =
  "Decisions are numbered 1 to 34 in the order I made them.";

export const DECISION_STATUS_NOTE =
  "Some were later changed by a newer one; the status line on each card says which, and says what main actually has.";

export const DECISION_CARDS_3: readonly DecisionCard[] = [
  {
    id: "decision-25",
    number: "25",
    title: "Booking emails and reminders through Resend",
    status: "Accepted, built",
    decision:
      "The booking app sends an email when a patient books, reschedules or cancels, and a reminder the evening before, through Resend from `reminders@mail.ericgitangu.com`. A Vercel cron runs once a day at 15:00 UTC (18:00 in Nairobi). The API hands out each reminder as a 15 minute lease and marks it sent only after Resend has accepted it.",
    cost: "A reminder can land up to an hour after 18:00, and one run sends at most 50. Delivery is at least once, so I rely on Resend's idempotency key to avoid a repeat. The daily limit of 100 and monthly limit of 3,000 are counted in the database, with 20 of the day's emails held back for confirmations. Only patients with a verified Google address are emailed, so a patient created through the open API gets nothing.",
    revisit:
      "More than about 50 appointments needing a reminder in one day, a need for a precise send time, or the sender domain being flagged as spam. The first two mean a paid plan; the third means moving the sending to its own subdomain.",
    related: ["decision-33"],
  },
  {
    id: "decision-26",
    number: "26",
    title: "Branding and SEO",
    status: "Accepted, mostly shipped",
    decision:
      "The site carries the Idyllic brand. Icons and the share image are generated from code at build time, the metadata comes from the Next.js metadata API, and the booking app publishes a sitemap and a robots file. A Lighthouse check runs in CI on `/`, `/book`, `/about` and `/data`, five runs each, judged on the median.",
    cost: "The logo files are copies of the ones in another project, so a change there does not reach this site. Accessibility, best practices and SEO must score 0.95 on every page and performance 0.85 on three of them. On `/` performance is only a warning, because its median moved between 77 and 89 across pipelines and a hard gate would have failed about every other run. The admin app tells crawlers to stay out entirely.",
    revisit:
      "A rebrand, or any score falling under its threshold. Once `/` holds a median clearly above 0.85 over several pipelines, I turn its warning into an error.",
    related: ["decision-27"],
  },
  {
    id: "decision-27",
    number: "27",
    title: "Two web apps in one workspace",
    status: "Accepted, shipped",
    decision:
      "The patient site and the staff dashboard are two separate Next.js apps in one pnpm workspace, deployed separately and sharing code through two internal packages: `packages/ui` for the interface and `packages/api` for the generated client and the call to the API. Each app has its own sign-in setup, secret and cookie, so a patient session is never a staff session.",
    cost: "More to run: two deployments, two ship and rollback jobs in CI, a second service account, and two auth configurations. Shared packages need care, and a workspace build can fail in ways a single app cannot. Staff sign-in is open to any Google account with a verified email; what a person can do is decided by their role ([decision 30](#decision-30)). The admin app's identity is the one that can call both Cloud Run services, the API and the live-feed service.",
    revisit:
      "A third audience such as doctors, or a hosting plan limit. Either could argue for one admin app with roles, or for a paid plan.",
    decisionsPage: ["thin-web-layer"],
    related: ["decision-28", "decision-30"],
  },
  {
    id: "decision-28",
    number: "28",
    title: "Public hostnames on my own domain",
    status: "Accepted, mostly shipped",
    decision:
      "Patients use `clinic.ericgitangu.com` and staff use `clinic-admin.ericgitangu.com`, one subdomain per app. The change was additive: I added the new hosts everywhere the old one was named, then switched, and kept the old `vercel.app` alias for a while before turning it into a redirect.",
    cost: "The DNS records are added by hand at a provider the repository cannot reach, and sign-in and bot-check settings take a few minutes to propagate. Many places name the host. The cookies are host-only, so the two apps never share a session. When I wrote this, demoting the old alias to a redirect was still to do.",
    revisit:
      "Moving the DNS to Vercel so the CLI can manage the records, or adding a third hostname.",
    related: ["decision-27", "decision-29"],
  },
  {
    id: "decision-29",
    number: "29",
    title:
      "The booking flow: server code, Google sign-in, one human check per action",
    status: "Accepted, shipped",
    decision:
      "Pages read through server components and every change goes through a server action, so the browser never holds a credential for the API. A patient must be signed in with a verified Google account, and booking, cancelling and rescheduling each carry their own reCAPTCHA token, rejected if it is missing, for another action, or scores under 0.5. Every call is checked against the generated contract on the way out and on the way back.",
    cost: "The public REST API stays open, as the brief asks, so the sign-in and the human check protect the screens and not a direct API call. Sessions are stateless cookies that last seven days and cannot be revoked early. There is no guest booking, so a patient needs a Google account. The bot check cannot be rehearsed on a preview deployment.",
    revisit:
      "A need to revoke one session at once, guest booking, or any real patient data.",
    decisionsPage: ["thin-web-layer", "rest-and-errors"],
    related: ["decision-27", "decision-30"],
  },
  {
    id: "decision-30",
    number: "30",
    title: "Staff roles granted by email, checked twice",
    status:
      "Accepted, shipped. Widened by decision 33 so admins can invite viewers",
    decision:
      "Staff access is a table of emails with three roles: owner, admin and viewer. The owner comes from configuration and is never a row. The dashboard looks the role up on every request, and the API checks it again on each endpoint, so a stale or forged claim cannot widen access. A revoke takes effect on the person's next click.",
    cost: "One extra API call per page view to resolve the role. Sign-in itself is open to any Google account, so a stranger gets a cookie that opens nothing. The role cannot live in the cookie, because a cookie cannot be revoked early. Revokes keep the row, so nothing is deleted. When I wrote this, the grant, change and revoke trail had no screen; the staff action trail now has one, but grants and revokes are still read from the table.",
    revisit:
      "Per-doctor or per-clinic scoping, a need to see access changes in the app, or moving sessions into a database.",
    decisionsPage: ["thin-web-layer"],
    related: ["decision-33", "decision-27"],
  },
  {
    id: "decision-31",
    number: "31",
    title: "Patient live push through Ably",
    status:
      "Accepted, shipped for patients. The staff feed is the Go service instead",
    decision:
      "A booking page gets slot changes pushed over Ably's free event stream. The API writes events to an outbox and a relay publishes them after commit, with no appointment id or patient data in the message. The browser holds a five minute subscribe-only token. Polling stays as the safety net: every 60 seconds while push is healthy and every 15 when it is not.",
    cost: "Ably is a third party that sees slot events, which carry only doctor, date, start time and kind. I cap publishing at 25,000 messages a month so that, counting every delivery, the free allowance cannot be passed. When that budget is spent the token endpoint answers 503 and the page falls back to polling. There is no always-on worker, so an event held behind an older open transaction waits up to 0.25 seconds for it, and after that waits for the next write, the next token request or the poll.",
    revisit:
      "More than 150 peak connections, more than 3,000,000 messages in a month, or a change to Ably's free terms. The fallback I would move to is Cloudflare Durable Objects.",
    decisionsPage: ["polling-then-push"],
    related: ["decision-32"],
  },
  {
    id: "decision-32",
    number: "32",
    title: "Admin live feed left out (reversed)",
    status:
      "Superseded. I decided it on 2026-10-18 and reversed it on 2026-10-19: the feed is built with the Go service",
    decision:
      "On 2026-10-18 I descoped the staff live feed for the submission, keeping the dashboard's cached numbers and a refresh button, to spend the time on patient push first. The reason was time and budget, not a technical limit.",
    cost: "That choice left the dashboard up to 60 seconds behind, and the server still published staff events to Ably that nothing read. The decision no longer holds: the dashboard and the appointment page now stream from the Go service and refresh every 30 seconds when it is full. The unread `admin:events` publishes still happen, and they are cheap.",
    revisit:
      "Nothing to revisit on the feed itself. The open item is the unread staff publishes: if they ever show up as a real share of the Ably budget, I turn them off.",
    decisionsPage: ["go"],
    related: ["decision-31"],
  },
  {
    id: "decision-33",
    number: "33",
    title:
      "Staff can book, move, cancel and veto, with a reason and an audit row",
    status: "Accepted, built",
    decision:
      "Staff create, reschedule and cancel for a patient through the same service functions the patient path uses, with a staff flag. Every staff write needs a reason and writes an append-only audit row in the same transaction. A veto undoes the patient's last change and locks the visit against further patient changes. Invites are single-use tokens, stored hashed, valid for 72 hours and tied to one verified Google email.",
    cost: "Undoing a cancel creates a new appointment, linked to the old one only by lineage. The audit rows leave out patient name, phone and email on purpose, so the trail shows what changed in the schedule and not who the patient was. Patient emails about staff changes are best effort with no retry, so a failure shows only as `notified` being false. Admins can now bring in viewers without the owner, a wider grant than before, and writes are throttled to 60 per person per 10 minutes. Staff are exempt from the one-hour rule and nothing else.",
    revisit:
      "Scoping roles per clinic, a second owner, email volume near the daily and monthly limits, or patient consent before staff changes. Then the invite rules, the notification path and the missing email outbox come first.",
    decisionsPage: ["veto-and-lock", "one-hour-rule"],
    related: ["decision-30", "decision-25"],
  },
  {
    id: "decision-34",
    number: "34",
    title: "Synthetic patients and a read-only public smoke",
    status:
      "Accepted, built on main: migrations 0008, 0012 and 0016, the smoke endpoint and the read-only public smoke",
    decision:
      "Test patients get a `synthetic` flag, which the admin queries filter out, and the only way to set it is a smoke endpoint that needs its own signing key, separate from the web apps'. The public smoke run on every release now only reads. The signed flow that writes runs on the tagged revision before promotion, and CI refuses to run without the key.",
    cost: "The earlier test patients are still in the database, only excluded from every admin figure, so a raw count of patients will not match the dashboard. The backfills match on names, which is a heuristic: a real patient who typed a smoke-style name through the open API could be marked by a future backfill of that shape. Slot availability still counts synthetic bookings, on purpose. The public smoke no longer exercises the write path on the public URL. I do not purge: the runtime role cannot delete, and I did not want a pipeline able to.",
    revisit:
      "Any real patient data, since the name-based backfills must not run again then. Also a second writer to production that needs the same door, which gets its own identity, or a decision to purge, which means a dry run first.",
    related: ["decision-33"],
  },
];

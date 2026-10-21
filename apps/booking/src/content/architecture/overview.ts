import type { TabContent } from "./types";

export const OVERVIEW: TabContent = {
  id: "architecture",
  label: "Architecture",
  intro:
    "The system as built, checked against the code on main. Names in the diagrams are the real ones: jobs in the CircleCI config, services in the infra folder, modules under the backend.",
  cards: [
    {
      id: "system-context",
      title: "System context",
      summary:
        "Who uses the clinic booking system and which outside services it relies on.",
      blocks: [
        { t: "diagram", id: "context" },
        {
          t: "p",
          text: "Patients and clinic staff both come in over HTTPS. Google handles sign-in and the reCAPTCHA Enterprise check, Resend sends booking emails and reminders, and Ably pushes slot events to pages that are already open.",
        },
        {
          t: "p",
          text: "CircleCI is the only thing that deploys, and only from the main branch. The rest of this tab opens the box in the middle.",
        },
      ],
    },
    {
      id: "containers",
      title: "Containers",
      summary:
        "What runs where: two Vercel apps, one IAM-only API, one database, and the ways in.",
      blocks: [
        { t: "diagram", id: "containers" },
        {
          t: "ul",
          items: [
            "**The browser never calls Cloud Run.** The only public entry points are the two Vercel projects. Cloud Run has no `allUsers` invoker, so a direct request gets a 403 ([hosting and cost](/decisions#hosting-and-cost)).",
            "**Vercel reaches Cloud Run with federation, not a key.** The app swaps Vercel's OIDC token at Google STS, then asks IAM for an ID token for the `clinic-api` audience (`packages/api/src/proxy/gcp-id-token.ts`). The token is cached until five minutes before it expires.",
            "**Two layers on `/internal/*`.** The ID token gets the request past IAM. A second, signed assertion (`X-Internal-Assertion`) says who is calling and with which role. The API checks it, then checks the role again in the database ([thin web layer](/decisions#thin-web-layer)).",
            "**The public `/api` proxy** forwards the brief's REST endpoints, refuses `/internal` in every spelling, and rate-limits each client at 120 requests a minute per instance by default.",
            "**One service not drawn here.** The staff live feed is `clinic-realtime`, a small Go service on Cloud Run (see [the Go decision](/decisions#go) and [Go gateway](#go-gateway)). The landing page diagram further down shows it.",
          ],
        },
        {
          t: "table",
          caption:
            "What main declares for each part. Rows with a date are observations from that day, not something re-read just now.",
          head: ["Part", "State on main", "More"],
          rows: [
            [
              "FastAPI service, Neon, the two Vercel apps, Google sign-in, reCAPTCHA per action",
              "Declared and shipped by the release pipeline. Cloud Run in us-east4, 0 to 3 instances; Neon on aws-us-east-1",
              "[one API](/decisions#one-api), [hosting and cost](/decisions#hosting-and-cost), [thin web layer](/decisions#thin-web-layer)",
            ],
            [
              "Idempotency keys, shell-only PWA, polling",
              "In the code. Availability polls every 15 s while the tab is visible and stops after 10 minutes without input",
              "[thin web layer](/decisions#thin-web-layer), [polling then push](/decisions#polling-then-push)",
            ],
            [
              "Resend email and reminders",
              "In the code. Booking and cancellation emails were seen live on 2026-10-18. The daily reminder runs from a Vercel cron at 15:00 UTC; its first send is still unconfirmed",
              "[third-party services](#third-party)",
            ],
            [
              "Outbox relay publishing to Ably",
              "In the code and called after each committing write. On 2026-10-18 Ably's 24 hour count went from 17 to 21 for one booking and one cancel",
              "[polling then push](/decisions#polling-then-push)",
            ],
            [
              "Browser subscription to the Ably channel, polling as the safety net",
              "In the code. While the stream is live the safety-net poll slows to every 60 s; see [Evidence](#evidence-live-push-production) for the production check",
              "[polling then push](/decisions#polling-then-push)",
            ],
            [
              "Self-hosted Swagger UI and ReDoc",
              "Served from the booking site at `/docs` and `/redoc`, with the bundles copied into the site's own assets",
              "[REST contract](/decisions#rest-and-errors), [API and collections](#swagger-redoc)",
            ],
            [
              "Go gateway for the staff live feed",
              "In the release pipeline as `ship-realtime`: Cloud Run, 0 to 2 instances, 0.25 vCPU, concurrency 1. On 2026-10-19 I read the service as Ready. The cost per connected hour is not measured yet",
              "[the Go decision](/decisions#go), [Go gateway](#go-gateway)",
            ],
          ],
        },
      ],
    },
    {
      id: "booking-flow",
      title: "Booking with an idempotency key",
      summary:
        "The unique index decides who gets a slot; a retry with the same key replays the answer.",
      blocks: [
        { t: "diagram", id: "booking-flow" },
        {
          t: "p",
          text: "The booking app first asks reCAPTCHA Enterprise to assess the action, then calls the API with an `Idempotency-Key` and the signed assertion. The API looks the key up for this patient first. The same key with the same doctor and time returns the booking made earlier with `Idempotent-Replayed`. The same key with a different doctor or time is `422 IDEMPOTENCY_KEY_REUSED`.",
        },
        {
          t: "p",
          text: "A new key goes straight to the insert. If another booking holds the slot, Postgres raises a unique violation on `uq_appt_doctor_slot_booked`. The API re-checks the key, because the winner may be this same request, and otherwise answers `409 SLOT_TAKEN`.",
        },
        {
          t: "p",
          text: 'The attempt key is generated in the browser. It stays the same for every retry of one attempt and changes when the doctor or time changes, because the API binds a key to the doctor and time it first came with. There is no "is the slot free?" query before the insert: the partial unique index is the arbiter ([double booking](/decisions#double-booking)).',
        },
      ],
    },
    {
      id: "slot-push",
      title: "A booked slot reaching other open pages",
      summary: "Outbox, relay, Ably, and a poll underneath it all.",
      blocks: [
        { t: "diagram", id: "slot-push" },
        {
          t: "p",
          text: "A booking writes the appointment and an `appointment_events` row in one transaction. The relay locks a single cursor row with `FOR UPDATE SKIP LOCKED`, reads events older than the snapshot, at most 100 at a time, debits the monthly publish budget, publishes to the channel `slots:{doctor_id}:{local_date}`, and moves the cursor only after Ably accepted the batch.",
        },
        {
          t: "p",
          text: "A page that opens the booking screen asks the API for a 5 minute, subscribe-only token for that one channel, then listens over SSE. A message is applied only if it is newer than the last one seen and newer than the page's availability cursor.",
        },
        {
          t: "p",
          text: "Push is an optimisation, not the source of truth. The relay runs inline after each committing write with a short timeout, because Cloud Run throttles CPU once the response is sent. An event stuck behind an open transaction waits for the next trigger. After three failed publishes in a row the relay pauses for a minute. A reload or a poll always shows the database's answer, and a stale click that loses the race still gets `409 SLOT_TAKEN`.",
        },
        {
          t: "p",
          text: "Polling is every 15 s while the tab is visible and drops to every 60 s while the stream is live; failures back off up to 120 s. With the push host blocked the page shows `data-stream=polling` and converges within 15 s, and a refused token leaves polling running. The staff live feed does not use Ably. The relay still publishes the admin events to the `admin:events` channel, which carry no patient data, and no screen subscribes to them.",
        },
      ],
    },
    {
      id: "release-pipeline",
      title: "The release pipeline",
      summary:
        "Every merge to main builds, deploys with no traffic, smokes, promotes, and rolls back on a red check.",
      blocks: [
        { t: "diagram", id: "release-pipeline" },
        {
          t: "p",
          text: "On a push to main, CircleCI runs the checks first: lint, backend quality, tests, contract, Go quality, the real Ably check, secret scan, static analysis, dependency audit, image scan, web quality, the end-to-end suites, the API collection and the static cost checks. Then it builds and scans the image and pushes it by digest.",
        },
        {
          t: "p",
          text: "`ship-api` signs in to Google with OIDC and workload identity federation, runs the `clinic-migrate` job by digest, deploys `clinic-api` with no traffic and a `sha-<7>` tag, runs `scripts/verify_claims.py` against the tagged URL, and promotes only if the commit is still the head of main. `ship-realtime` does the same for the Go gateway after the API. The Vercel apps follow with prebuilt deploys, then `verify-release` runs the public smoke and `/ready` with no credentials.",
        },
        {
          t: "p",
          text: "If the public check fails, `rollback-api` and `rollback-realtime` put traffic back on the previous revision, the two app rollbacks re-point the alias at the previous deployment, and the release stays red. Rollback refuses to go to the placeholder image or when something else has moved traffic ([rollback](#rollback)). After the rollbacks, `smoke-public` runs and then `zap-prod`; `cost-check` runs once the API and gateway have shipped.",
        },
        {
          t: "p",
          text: "Only main can deploy: the workload identity condition requires the main branch and the `gcp-deploy` context, so editing the config on a branch gains nothing. The release also prunes Artifact Registry to the serving image and the rollback image. The first real run on 2026-10-18 kept exactly those two.",
        },
        {
          t: "note",
          text: "The admin half of the web deploy, its rollback and the public checks after it need a project-scoped `VERCEL_ADMIN_TOKEN` in the `vercel-prod` context. On the `v1.1.0` release (152cff5) `ship-admin`, `verify-release`, `smoke-public` and `zap-prod` all reported success.",
        },
      ],
    },
    {
      id: "data-handling",
      title: "Data handling",
      summary: "What personal data is stored, where, and why.",
      blocks: [
        {
          t: "table",
          caption: "Where each kind of data lives.",
          head: ["Data", "Where", "Why", "Notes"],
          rows: [
            [
              "Patient name, optional phone and email, appointments, cancellation reason",
              "Neon Postgres",
              "The product",
              "`appointment_events` is the audit trail; logs carry a `request_id` and no personal data",
            ],
            [
              "Google subject, verified email, display name",
              "Neon (`patient_accounts`, `staff_access`); a stateless session cookie in the browser",
              "Sign-in and ownership of appointments",
              "Better Auth keeps no auth database ([thin web layer](/decisions#thin-web-layer))",
            ],
            [
              "reCAPTCHA token",
              "Sent to Google for an assessment, never stored by the app",
              "The human check on book, cancel and reschedule",
              "No secret is stored: the call uses the Vercel identity",
            ],
            [
              "Slot events: doctor, local date, start time, taken or freed, a sequence id",
              "Ably",
              "Live slot lists",
              "No appointment or patient identifier; the contract lives in `contracts/events/`",
            ],
            [
              "Patient name, doctor and time, sent to the signed-in patient's own verified address",
              "Resend",
              "Acknowledgements, and a reminder the evening before, from `reminders@mail.ericgitangu.com`",
              "Only linked, verified accounts are mailed. Resend keeps sent-mail records under its own retention",
            ],
          ],
        },
        {
          t: "p",
          text: "The public REST API has no patient authentication. The brief is silent on it, and I kept the public API open so Swagger's Try it out works. Anyone holding an appointment or patient UUID can read or change it there ([thin web layer](/decisions#thin-web-layer)). The signed-in screens close this in the web path only.",
        },
      ],
    },
    {
      id: "landing-architecture",
      title: "The landing page architecture",
      summary:
        "The one-picture version, with the Go gateway, Secret Manager and the registry.",
      blocks: [
        { t: "diagram", id: "architecture" },
        {
          t: "p",
          text: "This is the same diagram the booking site's landing page shows, next to a table of each component, what I chose and why. The diagrams above split it into one question each.",
        },
      ],
    },
  ],
};

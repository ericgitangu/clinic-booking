// The architecture table, in one place. The README's "Architecture" section carries the same rows
// word for word, and tests/site/architecture.test.ts fails if the two drift. The diagram itself is
// apps/booking/src/content/architecture.mmd, rendered ahead of time to public/architecture-{light,dark}.svg
// (see scripts/render_architecture.sh); nothing renders Mermaid in the browser.

export interface Decision {
  component: string;
  choice: string;
  why: string;
}

export const DECISIONS: readonly Decision[] = [
  {
    component: "Browser",
    choice:
      "Next.js pages with a shell-only service worker; polling as the fallback",
    why: "A stale slot list is the UX failure of the race the brief names. Push is an optimisation and polling is the floor.",
  },
  {
    component: "Booking and admin apps",
    choice: "Two Next.js apps on Vercel in one pnpm workspace",
    why: "Separate auth surfaces and deploys without publishing shared packages.",
  },
  {
    component: "Sign-in and roles",
    choice:
      "Better Auth with Google and stateless cookies; staff roles looked up on every request",
    why: "Maintained, no auth database, and a revoke applies on the next request.",
  },
  {
    component: "Calls to the API",
    choice:
      "Server-side BFF: Vercel's OIDC token exchanged at Google STS (workload identity federation) for a Cloud Run ID token, plus an HMAC-signed assertion of who is calling on /internal",
    why: "No credential in the browser and no stored key; the API checks the role again.",
  },
  {
    component: "API",
    choice: "FastAPI on Cloud Run, IAM-only, 0 to 3 instances",
    why: "One system of record for every rule; a direct request gets a 403.",
  },
  {
    component: "Database",
    choice: "Neon Postgres 17; a partial unique index decides double booking",
    why: "The engine enforces it across instances, with no application lock.",
  },
  {
    component: "Live updates",
    choice:
      "Outbox rows relayed to Ably right after each commit; the patient booking page subscribes over SSE with a 5 minute token (staff get their own feed from the Go service below)",
    why: "Ably's free package needs no card, and no server of ours holds streams open.",
  },
  {
    component: "Staff live feed",
    choice:
      "clinic-realtime, a small Go service on Cloud Run: read-only database role, 0 to 2 instances, one stream per instance, IAM-only, streaming to the admin app over SSE",
    why: "Staff events carry patient names, so they stay inside Google Cloud instead of going to a third-party pub/sub.",
  },
  {
    component: "Email",
    choice:
      "Resend, called from the booking app with a 5 second abort: after the response for booking, moving and cancelling (after()), and inline in the daily Vercel cron at 15:00 UTC for reminders",
    why: "A slow or failed email never fails a booking; the day (100) and month (3,000) allowances are reserved in the database before a send.",
  },
  {
    component: "Human check",
    choice:
      "The browser gets a reCAPTCHA token; the booking server creates a reCAPTCHA Enterprise assessment for each booking, cancel and reschedule, with an access token it gets through the same Vercel OIDC federation",
    why: "It runs on the server for every screen flow, and no secret is stored because the call uses the Vercel identity.",
  },
  {
    component: "Migrations",
    choice:
      "clinic-migrate, a Cloud Run Job that runs alembic as the clinic_owner role with its own database secret, before each deploy",
    why: "The running service has no DDL rights, and migrations are expand-only so the previous revision keeps working.",
  },
  {
    component: "Images",
    choice:
      "Artifact Registry, with CircleCI pushing each image by digest and only the two newest versions kept",
    why: "A rollback needs the previous image, and the registry's free tier is small.",
  },
  {
    component: "Delivery",
    choice:
      "CircleCI with keyless OIDC to workload identity federation for Cloud Run and a per-project token for Vercel; a tagged no-traffic deploy, a smoke test, promotion and automatic rollback",
    why: "No long-lived GCP credential exists, and only a smoke-tested revision gets traffic.",
  },
  {
    component: "Secrets",
    choice:
      "Secret Manager, mounted into Cloud Run and the migration job at deploy (database URLs, signing key, Ably key); the web apps keep theirs in Vercel environment variables",
    why: "Nothing secret is in an image or in the repository; Cloud Run reads them through its runtime service account.",
  },
];

export const GO_NOTE = {
  statement:
    "Go: the staff live feed runs on a small read-only Go service, clinic-realtime on Cloud Run, which README section 3.7 describes. I first closed PR 37 without merging and reversed that on 2026-10-19.",
  reason:
    'The cost reasoning is unchanged. The closing comment on PR 37 says: "The Cloud Run gateway billed about 900 vCPU-s per connected hour against roughly 21,619 vCPU-s of shared free-tier headroom, and capped the system at 2 concurrent streams." I read the 900 as per instance (0.25 vCPU for 3,600 seconds), and the service is built to that shape: 0.25 vCPU and at most 2 instances. The measured figure is still pending.',
} as const;

export const DIAGRAM_LABEL =
  "Architecture diagram. The browser reaches the booking and admin apps on Vercel. Those call clinic-api, a FastAPI service on Cloud Run that only accepts Google-signed identity, which uses a Neon Postgres database with a partial unique index. The clinic-migrate job runs alembic against the database. The admin app streams the staff live feed from clinic-realtime, a read-only Go service on Cloud Run. The API publishes slot events to Ably after each commit and the patient booking page subscribes over SSE. The browser gets a reCAPTCHA token and the booking app verifies it with reCAPTCHA Enterprise using a federated access token, and calls Resend. CircleCI pushes images to Artifact Registry and deploys keylessly, and Secret Manager supplies the API and the migration job. The table below lists each component, its choice and why.";

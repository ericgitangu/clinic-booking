import type { TabContent } from "./types";

export const EVIDENCE: TabContent = {
  id: "evidence",
  label: "Evidence",
  intro:
    "Each card is one dated observation that backs a claim the code cannot prove alone. They record what was seen on that day and nothing more.",
  cards: [
    {
      id: "evidence-ably-no-payment-method",
      title: "Ably account has no payment method",
      summary:
        "The free Ably package cannot be billed past its limits because no card is on file.",
      date: "2026-10-18",
      blocks: [
        {
          t: "p",
          text: '**What I observed.** The Ably account is on the Free package at $0, and its Billing section has only "Package" and "Usage". There is no payment-method or card page. This backs [polling then push](/decisions#polling-then-push), where one bound on the message cap is that usage past the free package cannot be billed.',
        },
        {
          t: "p",
          text: "**How.** The dashboard was read on 2026-10-18 by me and a second observer. The record was written by someone who did not look at the dashboard. Ably's free-package pricing page was re-fetched the same day, and its limits page was read.",
        },
        {
          t: "facts",
          items: [
            { label: "Package", value: "Free, $0" },
            {
              label: "Billing section",
              value: "Package and Usage only; no payment-method page",
            },
            {
              label: "Pricing page",
              value:
                "No credit card needed to sign up, no time limit on the free package",
            },
            {
              label: "Free package limits listed",
              value:
                "500 messages per second, 6,000,000 messages per month, 200 concurrent channels, 200 concurrent connections",
            },
            {
              label: "Limits page",
              value:
                "Says nothing about a payment method, and nothing about rejecting messages at the monthly cap",
            },
          ],
        },
        {
          t: "table",
          caption:
            "What was set up (names and capabilities only; no key values or key ids).",
          head: ["Item", "Detail"],
          rows: [
            ["App `clinical-booking-prod`", "Production Ably app"],
            [
              "Key `clinic-api-publish`",
              "Publish and Subscribe, restricted to channels `slots:*` and `admin:*`",
            ],
            ["Key `clinic-stats`", "Statistics only"],
            ["App `clinic-booking-ci`", "CI-only Ably app"],
            ["Key (CI)", "Publish, Subscribe and History; no stats"],
            [
              "Secret Manager secret `clinic-ably-api-key`",
              "One enabled version",
            ],
            [
              "CircleCI context `ably-ci`",
              "Holds `ABLY_API_KEY` (the CI app's key)",
            ],
            [
              "CircleCI context `gcp-deploy`",
              "Additionally holds `ABLY_STATS_KEY` (the `clinic-stats` key)",
            ],
          ],
        },
        {
          t: "p",
          text: "The Secret Manager and CircleCI rows are as reported to the person who wrote the record; they were not re-read for it. The other bounds in the live push design, the 25,000 a month publish cap and the 80 percent stats alarm, are not evidenced here.",
        },
        {
          t: "note",
          text: "This is a dated observation from 2026-10-18, not a standing guarantee. If the account or its billing settings change, this record does not.",
        },
      ],
    },
    {
      id: "evidence-iam-deny",
      title: "IAM deny probes (keyless deploy, IAM-only Cloud Run)",
      summary:
        "The probe format and a local dry run; no production run is recorded yet.",
      date: "2026-10-17",
      blocks: [
        {
          t: "p",
          text: "**What I observed.** Only a local dry run. The record is a template: the production records from CircleCI are not copied in yet. The dry run proves the record format and the redaction. It does not prove anything about production.",
        },
        {
          t: "table",
          caption: "What each probe is meant to show once it runs for real.",
          head: ["Probe", "Claim", "Where it runs"],
          rows: [
            [
              "`run-app`",
              "The direct Cloud Run URL refuses anonymous callers (403) and a junk bearer token (401), so no public Cloud Run exists to bill egress",
              "`smoke-public`, after every release",
            ],
            [
              "`wif`",
              "The token exchange from the empty `oidc-probe` context is refused, so a branch build cannot get deploy credentials",
              "`wif-deny-probe` on branch `test/wif-deny`",
            ],
            [
              "`context`",
              "None of the `gcp-deploy` or `vercel-prod` variables exist in a job outside those contexts",
              "Same job as `wif`",
            ],
          ],
        },
        {
          t: "p",
          text: "**How.** I ran the real probe script against a local HTTP stand-in that answers like Cloud Run (403 anonymous, 401 junk bearer) and like Google STS (403 `unauthorized_client`). The `context` record is a real run with none of the variables set. The run was at 2026-10-17T21:22Z.",
        },
        {
          t: "code",
          lang: "text",
          caption: "The `run-app` record from the stand-in server.",
          code: `# deny-proof probe record (redacted)
mode=run-app
time_utc=2026-10-17T21:22:00Z
commit=unknown
pipeline=local
target=direct run.app URL (no front door)
probe=run-app-anonymous expected=403 observed=403 result=PASS
probe=run-app-junk-bearer expected=401 observed=401 result=PASS
summary=all-refused`,
        },
        {
          t: "p",
          text: "**Result.** The `wif` record against the stand-in STS reads `expected=denied observed=denied result=PASS`, with a 403 `unauthorized_client`. The `context` record checked seven variables (`GOOGLE_PROJECT_ID`, `GOOGLE_PROJECT_NUMBER`, `DEPLOYER_SA`, `PUBLIC_BASE_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`), each `expected=absent observed=absent result=PASS`, summary `all-refused`.",
        },
        {
          t: "note",
          text: "This is a dated observation from a stand-in, not a standing guarantee and not a production result.",
        },
      ],
    },
    {
      id: "evidence-live-push-production",
      title: "Patient live push is on in production",
      summary:
        "The token endpoint answered and a real Chrome page went from polling to live.",
      date: "2026-10-18",
      blocks: [
        {
          t: "p",
          text: "**What I observed.** At about 13:55 UTC, after the release of main at commit 748d7d8, the patient token endpoint worked through the public proxy, and a booking page connected to Ably after the person acted. I recorded these as given; I did not make them myself. They back [polling then push](/decisions#polling-then-push).",
        },
        {
          t: "p",
          text: "**The release.** `ship-api`, `cost-check`, `ship-booking` and `ably-real` succeeded. `ship-admin` failed because `VERCEL_ADMIN_TOKEN` had not been added to the `vercel-prod` context, so `verify-release`, `smoke-public` and `zap-prod` did not run.",
        },
        {
          t: "p",
          text: "**How.** A request to the token endpoint through the public proxy, then loading a booking page in a real Chrome.",
        },
        {
          t: "code",
          lang: "text",
          code: "POST https://clinic.ericgitangu.com/api/realtime/token/patient",
        },
        {
          t: "facts",
          items: [
            {
              label: "With the site Origin",
              value:
                "HTTP 200, Cache-Control no-store, body fields channel, expires_at, stream_url, token, ttl_seconds",
            },
            { label: "With a cross-site Origin", value: "HTTP 403" },
            {
              label: "Page",
              value: "/book/<doctor>?date=2026-10-21 (Dr. Achieng Otieno)",
            },
            {
              label: "Rendered",
              value: "16 slot chips and two always-mounted role=status regions",
            },
            {
              label: "On load",
              value:
                'data-stream="polling" and data-polling="armed"; no token minted before the person acts, by design',
            },
            {
              label: "After one scroll and one key press",
              value:
                'data-stream="live": the token was minted and the stream connected to Ably',
            },
          ],
        },
        {
          t: "p",
          text: "No token value is recorded. At the time, the admin live feed was descoped; the Go service that serves it came later ([the Go decision](/decisions#go)). This check does not show a real booking by a second visitor reaching a first visitor's page in production. The live push CI scenarios cover that against the real service.",
        },
        {
          t: "note",
          text: "This is a dated observation from 2026-10-18, not a standing guarantee about what production does today.",
        },
      ],
    },
    {
      id: "evidence-spend-cap",
      title: "Cloud Run spend cap is configured",
      summary:
        "A $3 gross budget with a spend cap on Cloud Run, seen in the billing console.",
      date: "2026-10-18",
      blocks: [
        {
          t: "p",
          text: '**What I observed.** In Cloud Billing, Budgets and alerts, the budget `clinic-run-spend-cap-3usd` shows "Spend cap status: Configured". The Billing API cannot report whether a budget carries a spend cap, so the cost check reads this record instead.',
        },
        {
          t: "p",
          text: "**How.** I looked in the console on 2026-10-18. It is a console observation, not an API read, and nothing re-checks the console itself.",
        },
        {
          t: "facts",
          items: [
            { label: "Budget", value: "clinic-run-spend-cap-3usd" },
            { label: "Amount", value: "$3, gross (credits excluded)" },
            { label: "Scope", value: "The clinic project and Cloud Run" },
            { label: "Thresholds", value: "0.5, 0.8, 1.0" },
            { label: "Spend cap status", value: "Configured" },
          ],
        },
        {
          t: "p",
          text: 'The first version of this budget was created by Terraform and was alerts-only, with the console showing "Not applicable". The console would not create a capped budget while it existed, because a spend cap allows one budget per project and service and an existing budget cannot be converted. The Terraform budget was deleted, the console budget was created under the same name, and the resource was removed from the Terraform file. A $1 alerts-only budget, `clinic-alerts-1usd`, stays in Terraform. The record also lists a one-off Terraform state clean-up to run after that change merged.',
        },
        {
          t: "p",
          text: "The cap is a backstop. The $0 mechanism is the free-tier arithmetic and the ticket budget; the cap does not make the project free by itself.",
        },
        {
          t: "note",
          text: "This is a dated observation from 2026-10-18, not a standing guarantee. If the budget is edited in the console, this record is stale.",
        },
      ],
    },
  ],
};

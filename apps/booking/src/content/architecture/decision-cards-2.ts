import type { DecisionCard } from "./types";

// Decision cards for decisions 13 to 24. Each fact was checked against main.

export const DECISION_CARDS_2: readonly DecisionCard[] = [
  {
    id: "decision-13",
    number: "13",
    title: "Idempotency keys on booking",
    status: "Accepted, built",
    decision:
      "A booking request can carry an `Idempotency-Key`. I store the key and a hash of the request (doctor and start time) as two columns on the appointment row, with a unique index on patient and key. A retry with the same key and the same request returns the current appointment with `Idempotent-Replayed: true`.",
    cost: "There is no stored response body, so a replay shows the appointment as it is now, not as it was when first created. If the booking has since been cancelled the retry gets 409 `IDEMPOTENCY_KEY_CONSUMED`, and a different request under the same key gets 422 `IDEMPOTENCY_KEY_REUSED`. Rescheduling has no key.",
    revisit:
      "When another endpoint needs keys. Then a keys table that stores responses earns its place.",
    related: ["decision-3"],
  },
  {
    id: "decision-14",
    number: "14",
    title: "Hosting, region and the cost rules",
    status:
      "Accepted, built. The hosting split was re-decided on 2026-10-16 after a cost audit.",
    decision:
      "Cloud Run and Artifact Registry run in `us-east4`, next to Neon in `aws-us-east-1`, and Cloud Run is reachable only through the Vercel apps. The API runs with `--min-instances 0 --max-instances 3`, one vCPU, 512 MiB and CPU boost. I set a total cost ceiling of $0.50 a month, and `scripts/cost_check.sh` enforces it on every release.",
    cost: "The first plan was Frankfurt, and I dropped it because the billing audit could not prove $0 there: compute costs more and egress is billed from the first byte. What I pay for the US layout is a longer hop for users in Kenya, which I estimated and have not measured. The shared billing account has no free tier left for Secret Manager and Artifact Registry, so the project is not literally free.",
    revisit:
      "Real Kenyan patient data would need an African-region database. Any billing line above the ceiling, or a free tier changing, means re-running the cost check before the next deploy.",
    decisionsPage: ["hosting-and-cost"],
    related: ["decision-23", "decision-27", "decision-21"],
  },
  {
    id: "decision-15",
    number: "15",
    title: "Separate database roles, expand-only migrations",
    status: "Accepted, built",
    decision:
      "Migrations run as a `clinic_owner` role from a Cloud Run job. The API connects as `clinic_app`, which cannot change the schema. A lint script fails CI on destructive statements in a migration unless the line is marked `# contract-ok`, and Alembic takes an advisory lock so two migrations cannot run at once.",
    cost: "The lint reads one line at a time, so a destructive statement built in a helper or at runtime gets past it and needs a human reviewer. There is no automated test that the old release still works on the new schema. Two database secrets to rotate instead of one, and a third for the read-only live-feed role.",
    revisit:
      "At the first destructive migration. Before merging it I would adopt the expand, migrate, contract sequence and add the old-release compatibility test.",
    related: ["decision-21"],
  },
  {
    id: "decision-16",
    number: "16",
    title: "CircleCI with a keyless deploy",
    status: "Accepted, built",
    decision:
      "CI runs on CircleCI and signs in to Google Cloud with a short-lived OIDC token, so no service account key exists anywhere. A merge to `main` runs migrations, deploys the API as a no-traffic revision, smoke tests it, and only then moves traffic. If the smoke fails, traffic never moves.",
    cost: "The deploy job is tied to CircleCI contexts that I have to keep restricted to `main`, because anyone who can push a branch can edit the config file. A release on `main` takes about 28 minutes, measured on 2026-10-20. The Vercel token is long-lived, though scoped to one project.",
    revisit:
      "If I add a staging environment. That needs an approval job, a second identity condition and its own context.",
    decisionsPage: ["hosting-and-cost"],
    related: ["decision-14", "decision-17"],
  },
  {
    id: "decision-17",
    number: "17",
    title: "One security tool per concern, all blocking",
    status: "Accepted, built",
    decision:
      "Each kind of check has one tool that can fail the build: ruff's security rules and semgrep for code, pip-audit and `pnpm audit` for dependencies, gitleaks for secrets, trivy for images and infrastructure files, schemathesis against the API contract, and gosec and govulncheck for the Go service. The ZAP active scan runs on pull requests against a throwaway stack.",
    cost: "The ZAP job needs the larger machine executor, which uses more CI credits than any other job. It scans the API's OpenAPI surface only, so the live stream is covered by its own tests and not by ZAP. Production gets a passive ZAP baseline after each release, and no active scan.",
    revisit:
      "When the system holds real personal data. Then I would want an authenticated scan against a preview environment.",
    related: ["decision-16"],
  },
  {
    id: "decision-18",
    number: "18",
    title: "Tests on real Postgres, with a race that has to prove it raced",
    status: "Accepted, built",
    decision:
      "Everything runs against a real Postgres, with no SQLite and no mocked repositories. The race test fires 25 concurrent bookings at one slot and expects exactly one success. It also samples `pg_locks` and fails unless at least 5 transactions were waiting at once, so it cannot pass by accident. A control test drops the unique index and shows that check-then-insert does double-book.",
    cost: "Slower tests, and the test-only sleep hook and the naive booking service have to stay under `tests/` forever. CI gates are 85 percent overall and 95 percent on the domain code.",
    revisit:
      "If UI regressions start slipping through. Playwright already runs against the real API in CI, but not against the production URL.",
    decisionsPage: ["double-booking"],
    related: ["decision-3", "decision-21"],
  },
  {
    id: "decision-19",
    number: "19",
    title: "Logs and request ids, no tracing stack",
    status: "Accepted, built",
    decision:
      "The API writes one JSON log line per request, with a request id that also appears in every error body, plus the Cloud Trace header so Cloud Logging can correlate. Responses carry `Server-Timing`. SQLAlchemy runs with `hide_parameters=True`, and tests check that reasons and patient ids never reach the logs. `/health` never touches the database, and `/ready` runs `SELECT 1`.",
    cost: "No distributed traces and no metrics dashboards. When a problem crosses services I follow it by hand through the logs.",
    revisit:
      "When one service calls another, or an async worker appears. Then OpenTelemetry to Cloud Trace stops being optional.",
    related: ["decision-6"],
  },
  {
    id: "decision-20",
    number: "20",
    title: "Clean git history, disclosure in one place",
    status:
      "Accepted, done. `v1.1.1` is the submission tag (`v1.0.0` and `v1.1.0` are earlier ones), and the README disclosure section is written.",
    decision:
      "Commits follow Conventional Commits, one pull request per change, squash-merged, with no tooling trailers on commits I write. How the work was made is disclosed in a single README section, not scattered through commit messages. Local tooling files stay out of the repository through a local exclude file.",
    cost: "Keeping that disclosure current while I work is a discipline cost. Dependabot's own commits keep their bot lines; I left them. I rewrote commit messages once, only to replace an old numbering scheme with decision numbers, and no file changed. The `v1.0.0` tag points at c9e1119, the same tree it pointed at before.",
    revisit: "Nothing is planned.",
  },
  {
    id: "decision-21",
    number: "21",
    title: "A small Go service for the staff live feed",
    status:
      "Accepted, built. [decision 31](#decision-31) briefly replaced it, and I reinstated it because staff events carry patient names.",
    decision:
      "The staff live feed is a separate Go service, `clinic-realtime`, that polls the event table and streams it over SSE. It reads only: its database role has column-level `SELECT` and no write rights. The admin app's `/live/stream` route is the only way in, and it signs each request the way the API expects.",
    cost: "A second language, image, CI job and deploy job. Below 1 vCPU Cloud Run allows one stream per instance, and I cap the service at 2 instances, so two people can watch live at once. Cloud Run did not notice abandoned streams, which made one browser hold both instances, so all tabs in a browser now share one stream. Viewer-level redaction lives in the gateway's query and not in a second database role, which I accepted as debt.",
    revisit:
      "More than 5 gateway instances, 500 concurrent streams, a slow cursor query, or Neon connection errors. Then one relay (Redis pub/sub or Pub/Sub) replaces per-instance polling. If the feed is ever dropped, I delete the service rather than keep a second runtime for nothing.",
    decisionsPage: ["go"],
    related: ["decision-31", "decision-14", "decision-15"],
  },
  {
    id: "decision-22",
    number: "22",
    title: "Google sign-in and a bot check on booking forms",
    status:
      "Accepted in part. Sign-in moved to [decision 24](#decision-24), and the bot check uses reCAPTCHA instead of Turnstile. The Auth.js and stream-ticket design was not built.",
    decision:
      "The bot check is reCAPTCHA through Google Cloud. The booking server actions for book, reschedule and cancel verify a score of at least 0.5 (configurable) and the expected action name. There is no secret to hold: the server uses its existing Vercel identity to call the API through a service account that has one role.",
    cost: "Scripted clients of the web app fail by design. The public REST API is not protected by this check, because I kept the API open (the brief is silent on authentication) so Swagger's Try it out works. reCAPTCHA is free only up to a monthly allowance, so a flood of form submissions could cost money, and the per-IP limit in the proxy is the bound.",
    revisit:
      "Real patient data or an authenticated patient flow. Then bot enforcement moves into the API itself.",
    decisionsPage: ["thin-web-layer"],
    related: ["decision-24", "decision-30"],
  },
  {
    id: "decision-23",
    number: "23",
    title: "Cloud Run behind a Vercel front door",
    status: "Accepted, built for the API",
    decision:
      "Cloud Run has no public invoker, so a direct request to a `run.app` address is an IAM denial. The booking app's `/api/[...path]` route handler is the public entry: it exchanges a Vercel OIDC token for a Google ID token and forwards the request. It allows only GET, HEAD, POST, PATCH and OPTIONS, rejects bodies over 64 KB, and refuses any path that starts with `internal`. Swagger, ReDoc and the OpenAPI file are static routes built from the committed contract.",
    cost: "Every request pays an extra hop and the front door's own cold start. The per-IP limit is 120 requests a minute per function instance, so it stops casual loops and not a determined flood. Vercel becomes a hard dependency, and the public REST base gains an `/api` prefix. A leftover `/api/stream` mapping in the proxy code is dead, since IAM would refuse it. I have not deleted it yet.",
    revisit:
      "Users outside North America, a custom domain, or traffic near the free egress limit. Then a regional load balancer or a host with free egress to Africa.",
    decisionsPage: ["hosting-and-cost", "thin-web-layer"],
    related: ["decision-14", "decision-27"],
  },
  {
    id: "decision-24",
    number: "24",
    title: "Google sign-in with Better Auth",
    status:
      "Accepted, built. Roles later moved from an email allowlist to the staff table in [decision 30](#decision-30).",
    decision:
      "Patients and staff sign in with Google through Better Auth, mounted under `/auth` in each Next.js app. Sessions are stateless encrypted cookies that last 7 days, so there is no auth database. Every call from the web layer to the API carries a signed assertion with a 60 second lifetime that binds the method, the path and the body hash. A patient reaches only their own appointments, through `/internal/me` routes.",
    cost: "A session cannot be revoked early. The public REST API stays open by design, so the ownership check exists in the web layer and not in the API. Each assertion has a unique id, and staff writes record it, so a replay is refused with 401 `ASSERTION_REPLAYED`. Reads and patient routes can still repeat an assertion.",
    revisit:
      "A need to revoke one session at once. Then sessions move to a database.",
    decisionsPage: ["thin-web-layer"],
    related: ["decision-30", "decision-27", "decision-33"],
  },
];

# Architecture overview

Diagrams for the system as built, checked against the code and the ADRs. Names in the diagrams are the real ones (jobs in `.circleci/config.yml`, services in `infra/`, modules under `backend/app/`). Status of each part is in the table after the container diagram, because three parts are described in ADRs and pull requests that may not be running yet.

## 1. Context

```mermaid
flowchart TB
  P([Patient])
  ST([Clinic staff: owner, admin, viewer])
  SYS["Clinic booking<br/>REST API, booking app, admin app"]
  GO["Google<br/>sign-in, reCAPTCHA Enterprise"]
  RS["Resend<br/>booking emails and reminders"]
  AB["Ably<br/>pushes slot events to open pages"]
  CI["CircleCI<br/>builds, tests, deploys"]
  P -->|HTTPS| SYS
  ST -->|HTTPS| SYS
  SYS -->|"identity and human check"| GO
  SYS -->|"email"| RS
  SYS -->|"slot events"| AB
  CI -->|"deploys on merge to main"| SYS
```

## 2. Containers

```mermaid
flowchart LR
  B([Browser: patient or staff])
  subgraph V[Vercel]
    BK["Booking app (clinic-web)<br/>pages, server actions, /api proxy, /docs"]
    AD["Admin app (clinic-admin)<br/>dashboard, access page"]
  end
  subgraph GC["Google Cloud us-east4"]
    API["clinic-api: FastAPI on Cloud Run<br/>IAM-only, min 0, max 3<br/>every rule, outbox relay"]
    MIG["clinic-migrate: Cloud Run Job<br/>alembic as clinic_owner"]
  end
  DB[("PostgreSQL 17, Neon aws-us-east-1")]
  GO["Google: sign-in, reCAPTCHA Enterprise,<br/>STS and IAM for ID tokens"]
  RS[Resend]
  AB[Ably]
  CI[CircleCI]
  B -->|HTTPS| BK
  B -->|HTTPS| AD
  B -.->|"SSE, 5 min subscribe-only token"| AB
  BK -->|"Vercel OIDC to ID token"| GO
  AD -->|"same exchange"| GO
  BK -->|"ID token + signed assertion"| API
  AD -->|"ID token + signed assertion"| API
  API -->|"asyncpg, role clinic_app"| DB
  MIG -->|"role clinic_owner"| DB
  API -->|"publish slot events"| AB
  BK -->|"email, server side"| RS
  CI -->|"OIDC to WIF, deploy by digest"| API
  CI -->|"vercel deploy --prebuilt"| BK
  CI -->|"vercel deploy --prebuilt"| AD
```

Reading it:

- **The browser never calls Cloud Run.** The only public entry points are the two Vercel projects. Cloud Run has no `allUsers` invoker; a direct request gets a 403 ([ADR-0023](../adr/0023-zero-cost-edge-front-door.md)).
- **Vercel to Cloud Run uses federation, not a key.** The app exchanges Vercel's OIDC token at Google STS and then calls IAM `generateIdToken` for the `clinic-api` audience (`packages/api/src/proxy/gcp-id-token.ts`). The token is cached until five minutes before it expires.
- **Two layers on `/internal/*`.** The ID token gets the request past IAM. A second, signed assertion (`X-Internal-Assertion`, `packages/api/src/assertion.ts`) says who the caller is and with which role; the API checks it and checks the role again in the database ([ADR-0030](../adr/0030-staff-roles-and-access.md)).
- **The public `/api` proxy** forwards the brief's REST endpoints, denies `/internal` in every spelling, and rate-limits per client at 120 requests a minute per instance (`packages/api/src/proxy/rate-limit.ts`).

### What is running and what is declared

| Part | Status | Where it is described |
|---|---|---|
| FastAPI service, Neon, the two Vercel apps, Google sign-in, reCAPTCHA per action | Running | ADRs 0002, 0014, 0023, 0024, 0029 |
| Idempotency keys, shell-only PWA, 15 second polling | Running | ADRs 0013, 0010, 0009 |
| Resend email and reminders | Declared: PR 27 is open | [ADR-0025](../adr/0025-email-with-resend.md) |
| Outbox relay publishing to Ably | Running (PR 39; Ably's 24 hour count went from 17 to 21 on one booking and one cancel) | ADR-0031 (in PR 29) |
| Browser subscription to the Ably channel, polling as the safety net | Running (PR 44) | ADR-0031 |
| Self-hosted Swagger UI, ReDoc and fonts; production polish; production ZAP and Lighthouse; image prune | Running (PRs 36, 38, 32) | ADRs 0007, 0026, 0017 |
| Go SSE gateway and the admin live feed | Descoped (PR 37 closed) | [ADR-0021](../adr/0021-go-realtime-gateway.md) |

## 3. Booking, with an idempotency key and the unique index

```mermaid
sequenceDiagram
  autonumber
  actor B as Browser
  participant W as Booking app (server action)
  participant G as reCAPTCHA Enterprise
  participant A as clinic-api
  participant D as Postgres
  B->>W: submit (doctor, time, attempt key from crypto.randomUUID)
  W->>G: create assessment for action "book"
  G-->>W: score and action match
  W->>A: POST /internal/me/appointments, Idempotency-Key, signed assertion
  A->>D: BEGIN, then look up the key for this patient
  alt key seen before with the same doctor and time
    D-->>A: stored appointment
    A-->>W: 201 with Idempotent-Replayed (the booking made earlier)
  else key seen with a different body
    A-->>W: 422 IDEMPOTENCY_KEY_REUSED
  else new key
    A->>D: INSERT appointment (doctor_id, starts_at, key, fingerprint)
    alt another booking holds the slot
      D-->>A: unique violation 23505 on uq_appt_doctor_slot_booked
      A->>D: re-check the key (the winner may be this same request)
      A-->>W: 409 SLOT_TAKEN, or the replay if the winner was this request
    else slot free
      A->>D: INSERT appointment_events, COMMIT
      A-->>W: 201
    end
  end
  W-->>B: confirmation, or the typed error
```

The server action sends the same attempt key for every retry of one attempt and a new key when the doctor or time changes, because the API binds a key to the doctor and time it first came with (`apps/booking/src/components/booking/use-attempt-key.ts`). There is no "is the slot free?" query before the insert: the partial unique index is the arbiter ([ADR-0003](../adr/0003-double-booking-partial-unique-index.md), [ADR-0013](../adr/0013-idempotency-keys.md), `backend/app/services/booking.py`).

## 4. A booked slot reaching other open pages

```mermaid
sequenceDiagram
  autonumber
  participant A as clinic-api
  participant D as Postgres
  participant L as Ably
  actor B as Browser (another patient)
  A->>D: write appointment and appointment_events in one transaction
  A->>D: relay_once: lock the cursor row FOR UPDATE SKIP LOCKED
  A->>D: read events below the snapshot xmin, at most 100, debit the monthly budget
  A->>L: publish slot_taken on channel slots:{doctor_id}:{local_date}, id txid.id.part
  A->>D: advance the cursor only after Ably accepted the batch
  B->>A: POST /realtime/token/patient (doctor, date)
  A-->>B: 5 minute subscribe-only JWT for one channel
  B->>L: subscribe (SSE)
  L-->>B: slot_taken
  B->>B: apply if seq is newer than the last and after the availability cursor
  loop every 15 s while the tab is visible, and after every reconnect
    B->>A: GET availability
    A-->>B: slots and cursor
  end
```

Push is an optimisation, not the source of truth. The relay runs synchronously after each committing write with a short timeout, because Cloud Run throttles CPU once the response is sent; an event stuck behind an open transaction waits for the next trigger, and the polling loop covers the gap. After three failed publishes the relay stops for a minute. A reload or a poll always shows the database's answer, and a stale click that loses the race still gets `409 SLOT_TAKEN`. Steps 1 to 5 (the relay) and 6 to 7 (the token endpoint) are running (`backend/app/services/relay.py`, `realtime_tokens.py`, `contracts/events/README.md`). The browser subscribing and applying messages, steps 8 to 10, shipped in PR 44. With the push host blocked the page shows `data-stream=polling` and converges within 15 s, and a refused token leaves polling running. The admin live feed is descoped: the relay can publish admin events, and no admin screen reads them.

## 5. The release pipeline

```mermaid
sequenceDiagram
  autonumber
  participant G as GitHub main
  participant C as CircleCI
  participant R as Cloud Run
  participant V as Vercel
  G->>C: push to main
  C->>C: verify jobs (lint, tests, gitleaks, semgrep, pip-audit, trivy, ZAP, e2e-real, cost-static)
  C->>C: build-scan-push (image by digest)
  C->>R: ship-api: OIDC to workload identity federation, run clinic-migrate by digest
  C->>R: deploy clinic-api --no-traffic --tag sha-<7>
  C->>R: scripts/verify_claims.py against the tagged URL
  alt commit is still the head of main
    C->>R: promote: update-traffic to the tag
  else a newer commit exists
    C-->>C: skip promotion
  end
  C->>V: ship-booking and ship-admin (prebuilt deploy)
  C->>V: verify-release: public smoke and /ready, no credentials
  alt public check fails
    C->>R: rollback-api: traffic back to the previous revision
    C->>V: rollback-booking and rollback-admin: alias to the previous deployment
    C-->>G: release stays red
  end
  C->>V: smoke-public, then cost-check
```

Only `main` can deploy: the deploy contexts are restricted to the branch, and so is the workload identity federation condition, so editing the config on a branch gains nothing ([ADR-0016](../adr/0016-cicd-circleci-keyless-deploy.md)). The release also prunes Artifact Registry to the serving image and the rollback image (the first real run on 2026-10-18 kept exactly those two). The admin half of the web deploy, its rollback and the public checks that follow need `VERCEL_ADMIN_TOKEN` in the `vercel-prod` context (PR 46 split the Vercel token per project); until it is added they have not run on a release. Rollback refuses to go to the placeholder image or when something else has moved traffic ([`docs/runbooks/rollback.md`](../runbooks/rollback.md)).

## 6. Data handling

| Data | Where | Why | Notes |
|---|---|---|---|
| Patient name, optional phone and email, appointments, cancellation reason | Neon Postgres | The product | `appointment_events` is the audit trail; logs carry a `request_id` and no PII ([ADR-0019](../adr/0019-observability.md)) |
| Google subject, verified email, display name | Neon (`patient_accounts`, `staff_access`); a stateless session cookie in the browser | Sign-in and ownership of appointments | Better Auth keeps no auth database ([ADR-0024](../adr/0024-google-sign-in-with-better-auth.md)) |
| reCAPTCHA token | Sent to Google for an assessment, never stored by the app | The human check on book, cancel and reschedule | No secret is stored: the call uses the Vercel identity ([ADR-0029](../adr/0029-booking-flow.md)) |
| Slot events: doctor, local date, start time, `taken` or `freed`, a sequence id | Ably | Live slot lists | No appointment or patient identifier; contract in `contracts/events/`. Running |
| Patient name, doctor and time, sent to the signed-in patient's own verified address | Resend | Acknowledgements and a reminder the evening before, from `reminders@mail.ericgitangu.com` (a verified subdomain) | Only linked, verified accounts are mailed; Resend keeps sent-mail records under its own retention ([ADR-0025](../adr/0025-email-with-resend.md)). Declared: PR 27 is open |

The public REST API has no patient authentication, as the brief requires. Anyone holding an appointment or patient UUID can read or change it there ([ADR-0012](../adr/0012-identity-and-abuse-controls-deferred.md)); the README's section 10 states this.

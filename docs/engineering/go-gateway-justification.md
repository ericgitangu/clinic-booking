# Go gateway: justification draft, and what it was checked against

Draft for the engineer to rewrite in his own words. Three places carry the same reasoning: the README
section "3.7 The live feed: a Go service beside FastAPI" (in this PR), the `go` entry on `/decisions`
and one line on the landing page. The last two live in code owned by the `/decisions` page PR (#69),
which is not merged, so their text is here, ready to paste.

## The `go` entry for `apps/booking/src/content/decisions.ts`

Replaces the placeholder entry with id `go`. Two things change with it in that PR:
`tests/content/decisions.test.ts` asserts "exactly one placeholder", and `DECISIONS_DRAFT` stays `true`
until the engineer has edited the copy.

```ts
  {
    id: "go",
    title: "A small Go service for the staff live feed",
    decision:
      "I added a small Go service that streams the booking log to the staff dashboard. It only reads. Its database role can select a few columns and nothing else, and every write still goes through FastAPI.",
    gaveUp:
      "A second runtime to build, scan and deploy. Cloud Run bills while a stream is open, and below 1 vCPU it allows one stream per instance. So the service runs from zero to two instances and back to zero, and two staff can watch live at once. A third sees 'Live feed busy' and the page refreshes every 30 seconds instead. One connected hour is about 900 vCPU-seconds. The measured figure: to be measured after the first deploy.",
    why: "Booking rules and the double booking guarantee stay in one codebase with one test suite. Go only does the job it suits, many long-lived streams that sit idle and use little memory. Patient events carry no personal data, so Ably is fine for them. Staff events carry patient names and cancellation reasons. That stays inside our Google Cloud boundary: Go reads Postgres and streams to the admin app behind IAM. I first designed Go, then the plan moved everything to Ably and marked Go superseded without my sign-off. I reversed that on 2026-10-19.",
    revisit:
      "When more than two staff need the live view at once, or when there is more than one clinic. Then I move to pooled pub/sub inside Google Cloud, Pub/Sub or Redis, so a connection does not hold an instance.",
  },
```

## The landing line

The text is "Why a Go service sits next to the FastAPI one", linking to the anchor `/decisions#go`. It is
plain text here because the page does not exist on main until #69 merges.

## Each claim, checked against the code

| Claim | Checked against |
|---|---|
| The brief offers FastAPI or Go | The assessment line quoted when the gateway was first designed ("REST API in FastAPI, DRF or Go"); the brief itself is not in the repository, so the engineer should confirm the wording. |
| Every write stays in FastAPI | Migration `backend/migrations/versions/0014_realtime_reader_role.py` grants SELECT only; `backend/tests/integration/test_realtime_role.py` logs in as `clinic_realtime` and gets SQLSTATE 42501 for every insert, update, delete, DDL and for every column or table outside the grant; `services/realtime/internal/store/readonly_test.go` fails if any Go source sends a non-SELECT statement or calls a writing driver method (mutation-checked). |
| Patient events carry no personal data | `backend/app/schemas/events.py` (`SlotEvent`: `extra="forbid"`, fields `doctor_id`, `local_date`, `starts_at`, `kind`, `seq`), `contracts/events/slot-event.v1.schema.json`, and the banned-name check in `backend/tests/unit/test_realtime_domain.py`. |
| The old Ably admin channel carries no personal data either | `AdminEvent` in the same file. It is still published by the relay and nothing subscribes to it now; turning that publish off would save Ably messages. |
| Staff events carry names and reasons, viewers do not | `StaffEvent` (`contracts/events/staff-event.v1.schema.json`) against `AdminEvent`; `contracts/events/examples.v1.json` is checked by Python (`backend/tests/unit/test_event_examples.py`) and Go (`services/realtime/internal/events/events_test.go`); the wire is checked in `services/realtime/internal/gateway/stream_test.go` and in the browser by `apps/admin/e2e/live-feed.spec.ts`. |
| Streams are IAM-only and need the signed staff assertion with the role re-checked | `services/realtime/internal/gateway/auth_test.go`; assertion vectors signed by Python in `contracts/assertion-vectors.json`; invoker members pinned by `scripts/cost_check.sh` (C2) to the admin app and the smoke identity. |
| Below 1 vCPU Cloud Run allows one request per instance | The Cloud Run CPU limits page, "Maximum concurrency must be set to 1" (read 2026-10-19). |
| 0 to 2 instances and back to zero | The deploy line in `.circleci/config.yml` (`--min-instances 0 --max-instances 2`), pinned by `scripts/cost_check.sh --static` and its 17 mutation cases, and by the live check C1 (max exactly 2, min 0, throttling on). Scale-to-zero itself is not yet observed: it needs the deployed service. |
| About 900 vCPU-seconds per connected hour | 0.25 vCPU x 3,600 s (deduced). `scripts/ops/measure_realtime_cost.sh` measures it on the deployed service and fails above 1,100. Not yet measured. |
| About 21,619 vCPU-seconds of shared headroom | The figure recorded in the hosting cost analysis; `make shared-headroom` re-measures it. |
| Streams close at 290 s | `MAX_CONNECTION` in `services/realtime/internal/config/config.go`, tested in `lifecycle_test.go`; Vercel Hobby caps a function at 300 s (the Vercel limits page, as recorded in the front-door analysis). |
| The third client sees "Live feed busy, refreshing every 30 s" | `apps/admin/e2e/live-feed.spec.ts` (second viewer) and `apps/admin/tests/live-stream.test.ts`. |
| Revisit at more than two staff viewers | Follows from two instances at concurrency 1. |

import type { DecisionCard } from "./types";

export const DECISION_CARDS_1: readonly DecisionCard[] = [
  {
    id: "decision-1",
    number: "1",
    title: "A Makefile and a small pnpm workspace",
    status: "Accepted",
    decision:
      "One root `Makefile` is the entry point, with a uv project in `backend/` and a pnpm workspace over `apps/*` and `packages/*`: the two apps (`booking`, `admin`) and two packages (`ui`, `api`). The realtime service is a single Go module in `services/realtime/`, with the shared event schemas in `contracts/events/`.",
    cost: "There is no task-graph cache, which does not matter at this size. Node is needed at the root for the git hooks, and anyone who wants the Go tests needs a Go toolchain. I planned `rt-*` targets in the root `Makefile`; what exists is one `lint-go` target that calls into the Go module.",
    revisit:
      "A second Go module, or generated code shared across Go and TypeScript, would give me a real cross-package build graph. That is when I would adopt a task runner such as moon.",
    related: ["decision-27", "decision-21"],
  },
  {
    id: "decision-2",
    number: "2",
    title: "FastAPI is the only system of record",
    status: "Accepted",
    decision:
      "One FastAPI service owns the business rules and writes to Postgres. It is layered: routers only parse and serialize, services own transactions, the domain layer is pure, and repositories hold the SQL. Paths are the ones in the brief, with no `/v1`. The one piece of Go is the read-only live-feed gateway, which never writes.",
    cost: "Python starts slower from cold than Go would. I run `--cpu-boost`, one uvicorn worker and lean imports to soften it. With no `/v1` prefix, a breaking change later means introducing `/v2`. The Go gateway is a second runtime to build, scan and deploy.",
    revisit:
      "A measured p99 the Python service cannot meet, or a part of the system with different scaling needs from the booking path.",
    decisionsPage: ["one-api", "go"],
    related: ["decision-21", "decision-3"],
  },
  {
    id: "decision-3",
    number: "3",
    title: "A partial unique index stops double booking",
    status: "Accepted",
    decision:
      "A unique index on `(doctor_id, starts_at)` where `status = 'booked'` stops two bookings for one slot. A second index on `(patient_id, starts_at)` stops one patient holding two slots at once. Check constraints pin each visit to 30 minutes on a half-hour boundary, and the code maps the database error to a 409. There is no pre-check.",
    cost: "It is only correct for fixed, aligned 30-minute slots, and the alignment check assumes whole or half-hour UTC offsets. The constraint names are now part of the contract, so a test asserts they exist. I write the partial indexes as raw SQL because Alembic autogenerate does not handle them well.",
    revisit:
      "Variable visit lengths, or a clinic in an odd offset such as +05:45. Either one means moving to an exclusion constraint on time ranges, which needs `btree_gist`. Neon offers it but it is not installed.",
    decisionsPage: ["double-booking"],
    related: ["decision-4", "decision-8"],
  },
  {
    id: "decision-4",
    number: "4",
    title: "Slots are computed, not stored",
    status: "Accepted",
    decision:
      "Free slots come from a pure function that cuts a doctor's working windows into 30-minute steps and drops any step that overlaps a booked interval or falls inside the lead time. A request costs one query for the windows and one for that day's booked intervals.",
    cost: "There is no slot row to lock, so uniqueness has to come from the appointments constraint instead. The function takes the slot length as a parameter, but I took the public `slot_minutes` option out again: it advertised slots the booking path would reject.",
    revisit:
      "Per-clinic slot lengths would need a new column and an exclusion constraint. Separately, a search across 50 or more doctors would need one batched query to avoid N+1.",
    related: ["decision-3", "decision-5"],
  },
  {
    id: "decision-5",
    number: "5",
    title: "UTC in storage, the clinic zone as data",
    status: "Accepted",
    decision:
      "Times are stored as UTC `timestamptz`, and the clinic's IANA zone is a column on the clinic. A time sent without an offset is rejected with `TIMEZONE_REQUIRED`. The clock is injected, ruff bans direct wall-clock reads outside one module, and business SQL takes the current time as a parameter.",
    cost: "One extra join to read the zone. The DST tests run in Europe/Berlin because Nairobi has no DST. The two Next.js apps still keep the zone as a constant (`Africa/Nairobi`), so a second clinic would need a change in both. A static test fails if the seed and the two constants drift apart.",
    revisit:
      "A second clinic, especially one in a DST zone. The real fix then is for the apps to read the zone from the API.",
    decisionsPage: ["time"],
    related: ["decision-4"],
  },
  {
    id: "decision-6",
    number: "6",
    title: "Problem Details errors with a closed list of codes",
    status: "Accepted",
    decision:
      "Every non-2xx response uses the RFC 9457 `application/problem+json` shape, with a stable `code` from a closed list. Each `type` URL resolves at `/problems/<slug>`. My status rule: 404 when the path resource is missing, 422 when the request can never succeed as sent, 409 when it conflicts with current state and might succeed later.",
    cost: "A typed exception hierarchy with one handler stands in for returning errors as values, which is the idiomatic FastAPI route but a deviation from my usual rule. The list has 40 codes, and each one needs docs and a test.",
    revisit:
      "A client that needs translated messages. That would mean localizing `title`, keyed by `code`.",
    decisionsPage: ["rest-and-errors", "one-hour-rule"],
    related: ["decision-7", "decision-8"],
  },
  {
    id: "decision-7",
    number: "7",
    title: "REST and OpenAPI, not tRPC or GraphQL",
    status: "Accepted",
    decision:
      "The API is REST described by an OpenAPI 3.1 document that FastAPI produces, and `/docs`, `/redoc` and `/openapi.json` are public. I looked at tRPC, GraphQL, gRPC and ConnectRPC and turned them down: tRPC needs a TypeScript server, GraphQL answers 200 with an errors array, gRPC does not run in browsers, and the brief says REST.",
    cost: "Type safety comes from code generation and a CI drift check, not from inference across the wire. The Go gateway and FastAPI talk through a database table, so there was no case for gRPC between them either.",
    revisit:
      "Three or more different clients that need different shapes of the same data would point to GraphQL. Service-to-service streaming would point to Connect.",
    decisionsPage: ["rest-and-errors"],
    related: ["decision-11", "decision-6"],
  },
  {
    id: "decision-8",
    number: "8",
    title: "Reschedule is one locked update",
    status:
      "Accepted, amended by [decision 33](#decision-33) for staff exemptions, the veto lock and attendance",
    decision:
      "An appointment moves `booked` to `cancelled` and stops there. A reschedule is an in-place update of the same row under `SELECT ... FOR UPDATE`, using the same slot validation as a new booking. On a deadlock or serialization failure I retry once with a short jitter, then answer 409 `CONCURRENT_UPDATE`. The one-hour rule applies to every patient change: 422 `BOOKING_TOO_SOON` for a new time, 409 `CHANGE_TOO_LATE` for the current one.",
    cost: "Two requests swapping slots can both end with a 409 and the original state kept. I accept that. A patient cannot cancel a visit under an hour away from the app, and the visit keeps holding its slot. Arrival and no-show live in their own append-only table, so the status column never changed.",
    revisit:
      "Attendance was the one thing that could have added states, and it shipped as its own table. I would look again if a visit needs more than two states.",
    decisionsPage: ["one-hour-rule", "veto-and-lock"],
    related: ["decision-3", "decision-6", "decision-33"],
  },
  {
    id: "decision-9",
    number: "9",
    title: "Patients poll, staff get a stream",
    status:
      "Accepted, patient push replaced by Ably in [decision 31](#decision-31), staff feed built on the Go gateway",
    decision:
      'Patient pages poll for slots every 15 seconds, only while the tab is visible, and stop after 10 idle minutes. When live push is healthy the poll drops to 60 seconds. A 409 `SLOT_TAKEN` shows "just taken" and refetches. For staff, a Go service reads the `appointment_events` table with a commit-safe cursor and streams it over SSE, because an event id assigned at write time can commit out of order.',
    cost: "A patient can see a stale slot for a short while, and the 409 path covers it. The staff stream is a second deploy unit. It runs on Cloud Run with one stream per instance and at most two instances, so only two people can watch live at once. I dropped the stream ticket and monthly budget I had planned: the signed staff assertion does the authorization.",
    revisit:
      "Patients: a measured rate of `SLOT_TAKEN` conflicts that users actually notice. Staff: more than a couple of watchers at once, which would move fan-out to a relay.",
    decisionsPage: ["polling-then-push", "go"],
    related: ["decision-21", "decision-31", "decision-32"],
  },
  {
    id: "decision-10",
    number: "10",
    title: "A thin Next.js layer in front of the API",
    status:
      "Accepted, split into two apps by [decision 27](#decision-27); routes later changed",
    decision:
      "The web side is a server-first Next.js App Router app that acts as its own backend for the browser, so the browser never calls the API directly. Server components fetch, mutations are server actions or route handlers that check the session first, and the generated client keeps the UI to the contract. The admin dashboard reads aggregate endpoints under `/internal/admin/*`, left out of the public OpenAPI file.",
    cost: "A bigger surface to build and test, and a second deploy target. The admin endpoints are API surface outside the public contract. The patient routes ended up under `/book` and the dashboard under `/dashboard`, not the paths the first draft named.",
    revisit:
      "A clinic-operations need beyond a read-only dashboard, such as editing hours or managing doctors. That already grew into the staff roles of [decision 30](#decision-30).",
    decisionsPage: ["thin-web-layer"],
    related: ["decision-27", "decision-24", "decision-11"],
  },
  {
    id: "decision-11",
    number: "11",
    title: "One contract file, generated TypeScript",
    status: "Accepted",
    decision:
      "The pydantic models produce `contracts/openapi.json` with sorted keys, and `@hey-api/openapi-ts` turns it into types, zod schemas, an SDK and TanStack Query options in `packages/api`. The generated code is committed. CI fails if exporting the spec or regenerating the client changes any file. The event schemas under `contracts/events/` are generated from pydantic the same way.",
    cost: "The generator is pre-1.0, so I pin it to exactly 0.99.0 and do not bump it casually. Hand-written zod is only for form-only fields.",
    revisit:
      "A hey-api 1.0 release or a breaking minor one. At that point I would compare it against orval again.",
    decisionsPage: ["rest-and-errors"],
    related: ["decision-7"],
  },
  {
    id: "decision-12",
    number: "12",
    title: "The public API stays open; identity lives in the web layer",
    status:
      "Accepted, with the stretch items rebuilt differently (see [decision 22](#decision-22) and [decision 24](#decision-24))",
    decision:
      "The public REST API stays unauthenticated, as the brief specifies, and the README says so. Sign-in, roles and bot checks sit in the Next.js layer, which attaches a short-lived signed assertion to its calls. FastAPI trusts that assertion and does not verify Google tokens. Bot protection is reCAPTCHA, not Turnstile.",
    cost: "Anyone holding an appointment id can change that appointment through the public API, and patient listings are open to anyone who knows a patient id. I state that instead of hiding it. The proxy limits each client to 120 requests a minute per warm instance, and the API itself only throttles staff writes (60 per ten minutes per person).",
    revisit:
      "Any real patient data, when the API has to know who is calling. Abuse seen in the logs would also push me to add rate limiting inside the API.",
    decisionsPage: ["thin-web-layer"],
    related: ["decision-22", "decision-24", "decision-30"],
  },
];

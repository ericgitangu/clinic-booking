# ADR-0010: The Next.js web app: booking UI, admin dashboard and PWA

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-17, the engineer put the full production frontend in scope: server-first App Router, Google sign-in, an admin dashboard, branding, email

## Status

**Amended 2026-10-17: the admin dashboard is its own app, `apps/admin`, and the patient app moves to `apps/booking` ([ADR-0027](0027-two-apps-in-a-workspace.md)); hostnames are in [ADR-0028](0028-public-hostnames.md). Where this ADR says `/admin` inside the web app, read the admin app.**

Accepted. The web project is lean core because its proxy route handlers and landing page are the public URL ([ADR-0023](0023-zero-cost-edge-front-door.md)). The pages and features below are built as droppable slices in the order of the cut line at the end; dropping a slice never removes the proxy or the landing page.

**Build status (2026-10-18, main a2d1117): Partly shipped.** Shipped as two apps: the server-first booking flow, sign-in, the admin dashboard with its read-only `/internal/admin/*` endpoints and indexes, reCAPTCHA, the shell-only service worker with an offline page (#33) and the 60 second cached admin metrics (#30). Declared, not on main: emails and the reminder cron (PR #27, open). Paths and `/admin` routes in the body predate the split; see the amendment.

## Context

The brief only requires the API, but its scenario is a patient flow: "sees free slots ... picks one, books it ... Patients can cancel." The engineer decided to ship the whole flow as a real product: a booking UI for signed-in patients, an admin dashboard, branding, and email.

## Considered options

1. No UI; Swagger only.
2. A thin client-rendered UI that fetches in the browser.
3. A server-first App Router app that is its own backend-for-frontend (BFF): server components by default, mutations through server actions or route handlers, the browser never calls Cloud Run.

## Decision

Option 3.

- **Stack:** Next 16 App Router, React 19, TypeScript, shadcn/ui on Tailwind, lucide-react, next-themes (dark, light, system) and Geist via `next/font`. Versions are pinned and verified on the registry when each slice lands.
- **Data:**
  - Server components fetch on the server through one typed client. No `fetch` inside `useEffect`.
  - Mutations are server actions or route handlers, each checking the session first ([ADR-0024](0024-google-sign-in-with-better-auth.md)).
  - TanStack Query is used only where an interaction needs client state (the slot grid refreshing while a dialog is open, optimistic cancel). Server data is revalidated with tags, not polled by default.
  - The Idempotency-Key is created once per dialog open.
- **Contract:** zod schemas are generated from the OpenAPI document (`contracts/openapi.json`), so the UI and API cannot drift. Hand-written zod is allowed only for form-only fields.
- **Routes:**
  - `/` landing; `/docs`, `/redoc` and `/openapi.json` stay static and never touch Cloud Run.
  - `/doctors` and `/doctors/[id]`: the doctor list, the day's slot grid and a confirm dialog.
  - `/appointments`: the signed-in patient's own appointments, with cancel-with-reason and reschedule.
  - `/admin`: the dashboard, for the allowlisted admin only.
  - `/auth/*` sign-in (Better Auth) and `/cron/*` for scheduled work. Neither is under `/api`, which belongs to the proxy.
- **Errors:** every `ProblemCode` maps to human copy, exhaustively typed.
- **PWA:** a Serwist app shell with a manifest and an offline page. Navigations, RSC requests, `/api/*`, `/admin/**` and `/auth/*` are `NetworkOnly`; nothing about appointments is ever cached, because that would contradict "must not be available to others".
- **Theme:** `defaultTheme="system"`, a toggle on every page, no flash on load. The browser theme colour is set in the `viewport` export (`themeColor` for light and dark), not in `metadata`. Acceptance: a dark-mode hard reload shows no light flash.
- **Branding, SEO and email:** [ADR-0026](0026-branding-and-seo.md) and [ADR-0025](0025-email-with-resend.md).
- **Cost settings:** `apps/booking/vercel.json` and `apps/admin/vercel.json` each pin `"regions": ["iad1"]`; `images: { unoptimized: true }`; the generated client's base URL is the same-origin `/api` proxy for browsers and the BFF's own IAM-authenticated calls for server code.

### Caching

- Every `/internal/me/*` fetch is `cache: "no-store"`, and no page that reads a session is cached or shared between users. `revalidate` does not apply to pages that read the session, so it is not used on them.
- Admin data is session-independent once the admin check has passed, so only the data fetch is cached: a cached function keyed by `['admin-metrics', from, to, bucket]` with a 60-second lifetime and the tag `admin-metrics`, which the refresh button invalidates (`unstable_cache`, or `'use cache'` with `cacheLife`, whichever the pinned Next version documents when the slice is built). The session check runs outside the cached function, every time.

### Admin dashboard

An admin-only page with recharts. The first version has no realtime: the server fetches and the refresh button invalidates the tag. The Go SSE gateway ([ADR-0021](0021-go-realtime-gateway.md)) is optional and comes after the dashboard.

It needs aggregate endpoints that the public API does not have. They live under `/internal/admin/*`, are left out of the public OpenAPI document, require the BFF's signed assertion with `role = "admin"` ([ADR-0024](0024-google-sign-in-with-better-auth.md)), and are read-only. Two time axes are used on purpose: **activity** is bucketed by `appointment_events.occurred_at` (when someone booked, rescheduled or cancelled), **load** by `appointments.starts_at` (when the visit happens). Dates are clinic-local (`clinics.timezone`, Africa/Nairobi); `from` is inclusive, `to` exclusive.

- `GET /internal/admin/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=day|hour`: `bucket=day` allows at most 90 days, `hour` at most 7, and anything else is a 422 problem. Response: `{ range, bucket, series: [{ bucket_start, booked, rescheduled, cancelled }], totals: { booked, rescheduled, cancelled, upcoming_active }, per_doctor: [{ doctor_id, name, booked_visits, cancelled_actions, capacity, utilization }] }`.
  - **series** (activity, `appointment_events.occurred_at`):
    `SELECT date_trunc(:bucket, e.occurred_at AT TIME ZONE c.timezone) AS bucket_start, count(*) FILTER (WHERE e.event_type = 'booked') AS booked, count(*) FILTER (WHERE e.event_type = 'rescheduled') AS rescheduled, count(*) FILTER (WHERE e.event_type = 'cancelled') AS cancelled FROM appointment_events e JOIN doctors d ON d.id = e.doctor_id JOIN clinics c ON c.id = d.clinic_id WHERE e.occurred_at >= :from_ts AND e.occurred_at < :to_ts GROUP BY 1 ORDER BY 1`. The totals for the three counts are the sums of the series.
  - **upcoming_active** (load, `appointments`): `SELECT count(*) FROM appointments WHERE status = 'booked' AND starts_at >= now()`.
  - **per_doctor** (load, `appointments.starts_at`): `booked_visits` is `count(*) FILTER (WHERE status = 'booked')` over `starts_at` in the range, `cancelled_actions` is the number of `cancelled` events in the range by `occurred_at`, and `capacity` is the working-hours slot count: for each clinic-local date in the range, `sum((end_time - start_time) / interval '30 minutes')` over `working_hours` rows of that doctor whose `weekday` equals `extract(isodow FROM date)`. `utilization = booked_visits / capacity`, or null when capacity is 0.
- `GET /internal/admin/appointments?status=booked|cancelled|all&doctor_id=&from=&to=&limit=&cursor=`: `status` defaults to `all`; `limit` defaults to 25 and is at most 100 (above that is a 422). Order is `(starts_at DESC, id DESC)`. The cursor is `base64url` of `{"s": <starts_at ISO-8601 UTC>, "i": <appointment id>}`, and the page query is `WHERE (starts_at, id) < (:s, :i)`; a cursor that does not decode to that shape is a 422. The response is `{ items, next_cursor }` with `next_cursor` null on the last page.
- `GET /internal/admin/appointments/{id}/lineage`: `SELECT id, event_type, from_starts_at, to_starts_at, occurred_at FROM appointment_events WHERE appointment_id = :id ORDER BY id`, returned as the ordered path booked, then each reschedule with the old and new slot, then cancelled. An unknown id is a 404 problem.

**Indexes.** `uq_appt_doctor_slot_booked` on `appointments (doctor_id, starts_at) WHERE status = 'booked'` and `ix_events_doctor_id` already exist. The slice adds, in one expand-only migration: `ix_events_occurred_at` on `appointment_events (occurred_at)` for the series, `ix_events_appointment_id` on `(appointment_id, id)` for lineage, and `ix_appointments_starts_at` on `appointments (starts_at DESC, id DESC)` for the list and the load queries. At today's size (7 appointments, 19 events, 34 patients, read from production on 2026-10-17) every query is a trivial scan; the indexes are there so the cost stays flat as data accumulates, and they are a few kilobytes each.

**Amendment (2026-10-18): paths and routes as built.** The text above was written for one `web/` app. As built there are two apps: the booking app in `apps/booking` (routes `/`, `/book`, `/appointments`, `/docs`, `/redoc`, `/openapi.json`, `/auth/*`) and the admin app in `apps/admin`, whose routes are `/dashboard` (metrics, with appointment history and lineage under `/dashboard/appointments`) and `/access` (staff roles, [ADR-0030](0030-staff-roles-and-access.md)), not `/admin`. Access to the admin app is decided by role rather than by one allowlisted address. Where the Routes list says `/admin`, read `/dashboard` and `/access`; where the PWA bullet lists `/admin/**` as `NetworkOnly`, a shell-only service worker (PR #33) precaches an offline page and sends everything else to the network, which meets the rule above. `/cron/*` is not built; it arrives with the emails slice.

## Consequences

- Good: the reviewer sees the brief's scenario end to end, as a signed-in product.
- Good: the generated schemas keep the UI honest about the contract.
- Good: server-first means less client JavaScript, nothing secret in the browser, and the BFF is where ownership is enforced.
- Bad: a larger surface to build and test, and a second deploy target (`VERCEL_TOKEN`).
- Bad: the admin endpoints are new API surface outside the public contract; they are tested separately and protected by the signed assertion.
- Rejected inside this option:
  - A PWA that caches appointment data.
  - Vercel rewrites: cached by default, with a TTFB limit. The front door stays route handlers with `force-dynamic` ([ADR-0023](0023-zero-cost-edge-front-door.md)).
  - Polling or SSE for the first dashboard: revalidation is enough until the dashboard exists.

## Cut line

If time runs out, drop slices in this order, last built first. Each is independently droppable and never removes the one before it:

1. Emails and the reminder cron ([ADR-0025](0025-email-with-resend.md))
2. The admin dashboard
3. Google sign-in ([ADR-0024](0024-google-sign-in-with-better-auth.md)); without it the booking flow falls back to the demo patient picker with a "Demo mode" banner. Emails and the dashboard both depend on sign-in (the address and the role come from Google), which is why they are dropped before it
4. The booking flow, which includes bot protection on the booking, reschedule and cancel actions ([ADR-0022](0022-admin-auth-and-bot-protection.md)); dropping the flow drops the check with it
5. Design system, branding and SEO ([ADR-0026](0026-branding-and-seo.md)) last, because everything above builds on it. The reCAPTCHA footer attribution lives here, in the site footer, so it is on every page

Optional after all of these: the Go SSE gateway ([ADR-0021](0021-go-realtime-gateway.md)). Turnstile stays cut; reCAPTCHA replaces it ([ADR-0022](0022-admin-auth-and-bot-protection.md)).

## Assessment line

"A patient sees free slots for a doctor on a day, picks one, books it ... Patients can cancel."

## Review trigger

A clinic-operations requirement beyond a read-only dashboard (editing hours, managing doctors). That means a real admin area with roles and a database-backed identity.

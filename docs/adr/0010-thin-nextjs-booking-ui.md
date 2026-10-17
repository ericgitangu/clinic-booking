# ADR-0010: The Next.js web app: booking UI, admin dashboard and PWA

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-17, the engineer put the full production frontend in scope: server-first App Router, Google sign-in, an admin dashboard, branding, email

## Status

Accepted. The web project is lean core because its proxy route handlers and landing page are the public URL ([ADR-0023](0023-zero-cost-edge-front-door.md)). The pages and features below are built as droppable slices in the order of the cut line at the end; dropping a slice never removes the proxy or the landing page.

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
- **Theme:** `defaultTheme="system"`, a toggle on every page, no flash on load. Acceptance: a dark-mode hard reload shows no light flash.
- **Branding, SEO and email:** [ADR-0026](0026-branding-and-seo.md) and [ADR-0025](0025-email-with-resend.md).
- **Cost settings:** `web/vercel.json` pins `"regions": ["iad1"]`; `images: { unoptimized: true }`; the generated client's base URL is the same-origin `/api` proxy for browsers and the BFF's own IAM-authenticated calls for server code.

### Admin dashboard

An admin-only page with recharts, built from `appointment_events`. The first version has no realtime: data is fetched on the server and revalidated (`revalidate` of 60 seconds plus a refresh button). The Go SSE gateway ([ADR-0021](0021-go-realtime-gateway.md)) is optional and comes after the dashboard.

The dashboard needs aggregate endpoints that the public API does not have. They live under `/internal/admin/*`, are left out of the public OpenAPI document, require the BFF's signed admin assertion (ADR-0024), and are read-only:

- `GET /internal/admin/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=day|hour`
  - Clinic-local dates (Africa/Nairobi); at most 90 days; `bucket=hour` at most 7 days. Anything else is a 422 problem.
  - Response: `{ range, bucket, series: [{ bucket_start, booked, rescheduled, cancelled }], totals: { booked, rescheduled, cancelled, active }, per_doctor: [{ doctor_id, name, booked, cancelled, utilization }] }`.
  - Built with one grouped query over `appointment_events` (`date_trunc` in the clinic time zone) plus the working-hours capacity for `utilization`. It reads an existing index-friendly column; no new table.
- `GET /internal/admin/appointments?status=&doctor_id=&from=&to=&limit=&cursor=`: a keyset-paginated table for the dashboard.
- `GET /internal/admin/appointments/{id}/lineage`: the ordered events of one appointment (booked, then any reschedules with the old and new slot, then cancelled), for the lineage view.

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
3. Google sign-in ([ADR-0024](0024-google-sign-in-with-better-auth.md)); without it the booking flow uses the demo patient picker with a "Demo mode" banner
4. The booking flow
5. Design system, branding and SEO ([ADR-0026](0026-branding-and-seo.md)) last, because everything above builds on it

Optional after all of these: the Go SSE gateway ([ADR-0021](0021-go-realtime-gateway.md)). The Turnstile bot check stays cut ([ADR-0022](0022-admin-auth-and-bot-protection.md)).

## Assessment line

"A patient sees free slots for a doctor on a day, picks one, books it ... Patients can cancel."

## Review trigger

A clinic-operations requirement beyond a read-only dashboard (editing hours, managing doctors). That means a real admin area with roles and a database-backed identity.

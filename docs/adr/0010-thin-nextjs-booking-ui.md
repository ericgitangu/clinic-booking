# ADR-0010: A thin Next.js patient booking UI (optional tier), plus stretch PWA, theme and /admin

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, stretch S1 `/admin` dashboard, S2 PWA app shell + theme, S3 admin sign-in, S4 Turnstile added behind Gate B

## Status
Accepted. The booking pages are T2, the first item cut. Since the engineer's hosting decision the `web` project itself is lean core, because its proxy route handlers and landing page are the public URL ([ADR-0023](0023-zero-cost-edge-front-door.md)); cutting the pages never removes them. The stretch additions below are built only after Gate B, cut before any lean-core item, and drop automatically if this UI is cut.

## Context
The brief's scenario is a patient flow: "sees free slots ... picks one, books it ... Patients can cancel." The brief only requires the API. A UI makes the flow concrete, but it is the most expensive optional item.

## Considered options
1. No UI; Swagger only.
2. A thin Next.js 16 patient UI.
3. The full wish list: PWA, admin dashboard with charts, OAuth, custom typography.
4. Option 2 now, with a gated stretch tier on top: admin dashboard (S1), PWA app shell with network-only data (S2), admin-only OAuth (S3), Turnstile on the booking route (S4).

## Decision
Option 2 for the lean core, option 4 as gated stretch.
- **Stack:** next 16.4.2, react 19.3.1, @tanstack/react-query 5.104.3, zod 4.6.7, shadcn CLI 4.21.5 (button, card, dialog, calendar, select, toast), lucide, next-themes 0.4.6 (dark/light/system), and Geist via `next/font`. All versions verified on the registry on 2026-10-16.
- **Routes:**
  - `/`: a minimal landing page linking to Swagger (`/docs`), ReDoc and the spec (lean core, built in. The booking UI adds a "Book an appointment" link.
  - `/doctors`: the doctor list (moved from `/`).
  - `/doctors/[id]`: date picker, slot grid and confirm dialog.
  - `/appointments`: upcoming appointments, with a cancel-with-reason dialog and a reschedule picker.
- **Data:**
  - Client components with TanStack Query, following the `getQueryClient` pattern (staleTime 30 s). No Server Actions as queryFn.
  - Polling as in ADR-0009.
  - The Idempotency-Key is created once per dialog open (`useRef`).
- **Identity:** a patient picker (create a patient, or choose a seeded demo patient), stored in `localStorage` with guarded access. A banner reads "Demo mode: no authentication".
- **Errors:** every `ProblemCode` maps to human copy, exhaustively typed.
- **Deploy:** Vercel, from CircleCI only. Vercel's own Git deploys are disabled. `ship-web` is lean core, because it also deploys the proxy.
- **Cost settings (added by the $0 audit):** `web/vercel.json` pins `"regions": ["iad1"]` (Hobby allows a single function region); `next.config.ts` sets `images: { unoptimized: true }` so the 5,000 image transformations a month on Hobby are never used; icons are static files. The generated client's base URL is the same-origin `/api` proxy in this project (ADR-0023), not `*.run.app`, which is IAM-gated.

**Stretch additions (each only if its WP ships):**
- **`/admin` (S1,):** recharts time series of bookings, cancellations and reschedules per clinic-local hour, and per-doctor utilization for today. Initial data from `GET /admin/metrics`; live increments from the Go gateway's SSE stream (ADR-0009, ADR-0021). The stream closes on a hidden tab and after 10 minutes idle. The patient pages keep polling.
- **PWA (S2,):** Serwist app shell with a manifest, icons and an offline page. Navigations, RSC requests, `/api/*`, `/admin/**`, the API origin and the realtime origin are all `NetworkOnly` (navigations fall back to the precached offline page through a catch handler). Serwist's `defaultCache` is not used, and no `NetworkFirst` route exists, because `NetworkFirst` stores responses and serves them on a slow network, which would keep authenticated `/admin` HTML after sign-out. No data is precached and there is no background sync. Stale availability is a correctness hazard, so offline means "you need a connection", never cached slots. Acceptance: an accessibility score of at least 0.9 in Lighthouse plus a DevTools installability check (Lighthouse 12 has no PWA category).
- **Theme (S2):** next-themes, already part of the lean-core stack, with `defaultTheme="system"`, a toggle on every page including `/admin`, and no flash on load (`suppressHydrationWarning`, class attribute, transitions disabled on change). Acceptance: a dark `prefers-color-scheme` hard reload shows no light flash.
- **Admin sign-in (S3):** Auth.js v5 Google provider for `/admin` only (ADR-0022).
- **Turnstile (S4):** the booking dialog posts to a same-origin route handler (`/ui/appointments`; `/api/*` belongs to the proxy) that verifies the token and forwards to the API (ADR-0022). This is a route handler with `no-store`, not a rewrite.

## Consequences
- Good: the reviewer sees the brief's scenario end to end.
- Good: the generated client keeps the UI honest about the contract.
- Bad: a second deploy target, and `VERCEL_TOKEN`, which is lean core since the proxy lives in this project.
- Rejected inside this option:
  - A PWA that caches availability or appointment data: it contradicts "must not be available to others". The S2 shell-only PWA with network-only data is the version we accept.
  - Vercel rewrites: cached by default, with a TTFB limit. The front door in ADR-0023 is route handlers with `force-dynamic` inside this project (first drafted as a separate project, superseded), not a rewrite, so this rejection stands.
  - Admin chart and OAuth: no longer deferred; they are gated stretch S1 and S3 (ADR-0021, ADR-0022).

## Assessment line
"A patient sees free slots for a doctor on a day, picks one, books it ... Patients can cancel."

## Review trigger
An explicit clinic-operations requirement beyond the read-only stretch dashboard (editing hours, managing doctors). That means a real admin area with roles and an IdP.

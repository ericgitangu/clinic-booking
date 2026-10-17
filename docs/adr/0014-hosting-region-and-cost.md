# ADR-0014: Hosting, region and cost

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, $0 cost audit: region moved from europe-west3 to us-east4 (Tier 1, North America egress tier), Neon to aws-us-east-1, the edge to an IAM-gated Vercel front door ([ADR-0023](0023-zero-cost-edge-front-door.md)), and every cost line proven against an official free tier in

## Status

Accepted

**Build status (audit 2026-10-17): Mostly built, text stale.** Cloud Run, Artifact Registry and the budgets are in us-east4 behind an IAM-gated front door, with `cost_check.sh` guarding the limits. The web tier is two Vercel apps, not one `web` project. Console or external, not visible in the repo: the $3 spend cap and the Neon settings. Pending: the realtime service (S1).

## Context

- **Cost rule.** Our infrastructure rule forbids always-on resources: no min-instances > 0, no NAT, no load balancer, no Cloud SQL.
- **Region preference.** Our default region is africa-south1.
- **Database location.** Neon has no African region. The nearest is aws-eu-central-1 (Frankfurt).
- **Round trips.** A booking makes 4-6 sequential DB round trips.
- **Zero-cost rule (added 2026-10-16).** Total cost must be $0, proven from official free-tier documents, not estimated as low. What the cost audit read on 2026-10-16 (Cloud Billing Catalog API, service `152E-C115-5142`, and cloud.google.com/run/pricing):
  - `europe-west3` is billed at Tier 2 ($0.0000336/vCPU-s, $0.0000035/GiB-s). The free tier is a spend-based discount priced at Tier 1, so in a Tier 2 region it buys about 29% less compute (about 128,571 vCPU-s instead of 180,000; deduced from the two prices). `us-east1`, `us-east4`, `europe-west1`, `europe-west4` and `africa-south1` are Tier 1. **Verified.**
  - Cloud Run internet egress is free only North America to North America (first 1 GiB a month). Europe, Africa and intercontinental egress are billed from byte 0. **Verified.**
  - Cloud Storage Always Free applies only in `us-west1`, `us-central1` and `us-east1`. **Verified (cloud.google.com/storage/pricing, read by the audit).**

## Considered options

1. Cloud Run in africa-south1 with Neon in Frankfurt.
2. Cloud Run in europe-west3 (Frankfurt) with Neon in aws-eu-central-1.
3. Cloud SQL in africa-south1. Rejected outright: it is always-on.
4. Cloud Run in us-east4 with Neon in aws-us-east-1, reached only through a Vercel front door in iad1 (ADR-0023). Added by the $0 audit.

## Decision

**Option 4** (amended 2026-10-16). Option 2 was the decision until the $0 audit showed that europe-west3 cannot be proven $0: its compute is Tier 2 and every byte it sends to Kenya, Vercel or Neon is billed. Option 4 keeps option 2's reasoning (Cloud Run next to the database, so the 4-6 DB round trips stay short) and moves the pair to the one place where Cloud Run's egress has a free tier. The details of the edge are in ADR-0023. Everything below reads `us-east4` where it used to read `europe-west3`.

**`clinic-api` settings:**

| Setting | Value |
|---|---|
| Region | `us-east4` (Tier 1; verified in the Cloud Billing catalog, 2026-10-16) |
| Instances | `--min-instances 0 --max-instances 3` (both asserted by the `cost-check` job) |
| Concurrency | `--concurrency 80` |
| Resources | `--cpu 1 --memory 512Mi --cpu-boost` |
| Timeout | `--timeout 60` |
| Billing | request-based (default) |
| Service account | `clinic-api-runtime` |
| Secrets | `--set-secrets DATABASE_URL=clinic-database-url-app:latest` |
| URL | IAM-gated `*.run.app` with no `allUsers` binding; the public URL is the Vercel front door (ADR-0023). Custom audience `clinic-api` (`--add-custom-audiences`) |

**Database connection:**

- Neon Free project in **aws-us-east-1** (amended from aws-eu-central-1, so the database stays beside Cloud Run us-east4), compute fixed at **0.25 CU** (autoscaling min = max = 0.25). Neon Free gives 100 CU-hours per project a month and suspends rather than bills when they run out (neon.com/docs/introduction/plans, read 2026-10-16); an always-awake 0.25 CU compute would use 186 CU-hours a month (744 h × 0.25, deduced), so scale-to-zero must keep working and nothing may ping the database on a schedule.
- The direct (non-pooler) Neon endpoint, with `postgresql+asyncpg://...?ssl=require`. There are no `sslmode` or `channel_binding` params, and a config validator rejects them (**unverified**; `/ready` check confirms it).
- Pool: `pool_size=5, max_overflow=0, pool_pre_ping=True, pool_recycle=240, hide_parameters=True`, so at most 15 connections. Using the direct endpoint avoids asyncpg statement-cache issues behind PgBouncer.

**Other components:**

- Artifact Registry `clinic` in **us-east4** (co-located with Cloud Run, so image pulls cross no region). Target: **at most 2 versions per package** (`clinic-api`, `clinic-realtime`), enforced three ways: a cleanup policy (keep the 2 most recent versions; delete untagged versions and anything older than 7 days that the keep rule does not protect), a CI prune right after promotion (cleanup policies take effect within about a day), and the `cost-check` job asserting the repository's `sizeBytes` is below 400,000,000. Cloud Run traffic tags are pruned to the last 2 to match, so no tagged revision points at a deleted image.
- Vercel Hobby for two projects (amended 2026-10-17 by [ADR-0027](0027-two-apps-in-a-workspace.md); this line first said a single `web` project): `clinic-web`, the booking app (`apps/booking`), whose route handlers are the front door, and `clinic-admin`, the admin app (`apps/admin`). Both are pinned to `iad1` with `"regions": ["iad1"]` in `apps/booking/vercel.json` and `apps/admin/vercel.json` (amended by the engineer's decision; the separate front-door project `clinic-frontdoor` is superseded and does not exist).
- A GCP budget alert at $1. **It only alerts; it does not cap spend** (cloud.google.com/billing/docs/how-to/budgets: an alerts-only budget "doesn't automatically cap ... usage or spending"). What actually caps spend is listed under "Cost" below.
- Terraform state bucket in **us-east1** (a Cloud Storage Always Free region; us-east4 is not one), Standard class, single region.
- **Stretch S1:** `clinic-realtime` in **us-east4** beside the API (same Neon latency argument). **`--min-instances 0 --max-instances 2 --concurrency 1 --cpu 0.25 --memory 256Mi --cpu-boost --timeout 300`** (amended for the CPU allowance; see "Realtime cost arithmetic"), SA `clinic-realtime-runtime`, secret `clinic-database-url-realtime`, direct Neon endpoint with at most 2 connections per instance. Total connections become at most 15 + 4.

**Latency for option 2 (superseded by option 4 below; kept for the record; estimate, unmeasured).** Each africa-south1 → Frankfurt round trip is estimated at 150-200 ms. Option 2 pays one long client hop per request instead of 4-6 long DB hops. The deploy checks publish measured cold and warm latency.

**Latency re-weighed for option 4 (estimate, unmeasured).** The DB argument is unchanged: Cloud Run us-east4 (Ashburn) and Neon aws-us-east-1 (N. Virginia) are deduced to be in the same metro, so the 4-6 DB round trips cost a few ms in total, as Frankfurt-Frankfurt did. What gets worse is the client hop: Kenya → US East is longer than Kenya → Frankfurt, and the front door adds a function hop and its own cold start. Our estimate is about 100-150 ms more per warm request than option 2, and a cold first request that can now include three cold starts (Vercel function, Cloud Run, Neon). We accept that for a demo in exchange for a provable $0; it is the first thing to revisit if the system ever had real Kenyan users (and those would also need an African-region database). The deploy checks measure cold and warm latency through the front door.

### Cost

**Summary ($0 rule, amended 2026-10-16; full per-resource proof in).** Every resource sits inside a documented free tier, with the headroom computed in this ADR against a worst-case month (an admin dashboard live 8 h a day for 7 days, 40 CI pipelines, 200 bookings). Deduced use of the binding limits in that month: Cloud Run CPU about 32% of 180,000 vCPU-s, North America egress about 50% of 1 GiB, Artifact Registry at most about 62% of 0.5 GiB, Secret Manager 4 of 6 active versions, Neon about 35 of 100 CU-hours, CircleCI about 22,200 of 30,000 credits. What enforces it:

| Guard | Kind | What it stops |
|---|---|---|
| `--max-instances 3` / `2`, `--min-instances 0`, timeouts 60 s / 300 s, job `--task-timeout 600s --max-retries 0` | hard (platform) | Runaway compute; asserted by `cost-check` |
| Cloud Run budget, $3 gross, project + Cloud Run service | alerts-only (verified 2026-10-18: Spend cap status "Not applicable"; see the amendment below) | Alerts when gross compute nears the $4.32 Tier 1 CPU discount; it does not pause usage |
| No `allUsers` invoker, no `--allow-unauthenticated`, no `--no-invoker-iam-check`; the booking app's proxy and the apps' server calls only (ADR-0023, ADR-0027) | hard (IAM) | Billed egress to non-North-America clients; denied requests are not billed |
| Neon Free, Vercel Hobby, CircleCI Free with no card | hard (plan) | They pause or block at their limits and cannot bill |
| Artifact Registry 2 versions per package + `sizeBytes` < 400 MB assert | configuration | Storage past 0.5 GiB |
| Destroy, never disable, old secret versions; ≤ 6 active asserted | configuration | Secret versions past 6 |
| State bucket in us-east1, lifecycle, soft delete off | configuration | Storage billed outside the Always Free regions |
| Daily egress alert policy (free until at least 2027-09-01; delete or re-audit before 2027-08-01) + kill switch | detection + manual stop | Egress past 1 GiB under a flood |
| One free `_Default` log exclusion, `drop-iam-denied`, for IAM-denied 401 and 403 request logs (widened from 403 only by the hosting lock review; a junk bearer gets 401) | configuration | Log ingestion past 50 GiB under a flood of direct requests |
| $1 alerts-only budget | detection only | Nothing by itself; it tells us something escaped the guards |

The remaining non-capped surfaces (Artifact Registry, Secret Manager, Cloud Storage, egress) are held at $0 by configuration and checks, not by a platform cap. We say that plainly rather than call the budget a cap.

**Amendment, 2026-10-16: the billing account is shared.** The plan assumed a dedicated billing account. None could be opened (5 of 5 slots in use), so `sil-clinic-booking` is linked to the shared "Firebase Payment" account `01C382-12CD13-DCA6EF`, alongside `nanolend-api`, `master-crossing-435409-r1`, `pawacloud-assessment` and `unicorns-484301`. Every per-account free tier is therefore shared. Measured over the last 30 days: the other projects used 63,981 request-based vCPU-s, 11,666 instance-based vCPU-s and 15,610 requests; each billing mode has its own free tier (180,000 and 240,000 vCPU-s), and with this project's worst month the request-based use is 158,381 vCPU-s (headroom 21,619, 12.0%) and $4.08 of its $5.22 discount, instance-based 11,666 vCPU-s and $0.22, so Cloud Run compute stays $0 on observed use, thinly and without a guarantee (the other projects can spend the whole tier on their own, and our budget cannot see them). Artifact Registry (about 27.8 GiB held by the others against 0.5 GiB free) and Secret Manager (50 active versions against 6 free) are already past their free tiers, so this project is **not $0**: about $0.28 a month (deduced from list prices and our 400 MB and 4-version bounds). The engineer accepted the about $0.28 a month on 2026-10-16 (option A); compute and egress must stay within the free tier. Consequences applied: the $1 alerts budget is scoped to this project (`infra/billing`, run as the billing user), the project-list check asserts the recorded project list instead of "only this project", and `make shared-headroom` re-measures the others.

**Security amendment, same date.** The default Compute service account holds `roles/editor`. Terraform removes that one binding (`default_sa.tf`), every deploy passes an explicit `--service-account`, and a live check plus a static rule check both.

**Cut for cost.** Anything that could not be proven $0 is out: Europe hosting (Tier 2 compute and egress from byte 0), a public `allUsers` invoker, Artifact Analysis scanning ($0.26 per image, no free tier; trivy in CI instead), Cloud Build and `gcloud run deploy --source`, a state bucket outside the free regions, CircleCI Docker layer caching, Vercel image optimization, uptime pingers. Reasons

**Cost (estimated at demo traffic; observed numbers replace these in the README).** The original table follows, with each line amended by the audit:

| Item | Plan | Est. $/mo |
|---|---|---|
| Cloud Run | Free tier in us-east4 (Tier 1, verified); $3 gross budget, alerts-only | 0 |
| Neon | Free | 0 |
| Vercel | Hobby | 0 |
| CircleCI | Free credits (30,000 a month; budget 22,200 worst case) | 0 |
| Artifact Registry | at most 2 versions per package, < 400 MB (free 0.5 GiB) | 0 |
| Secret Manager | 3 secrets, 1 active version each (the two database URLs and the internal signing key; 4 during a rotation). The shared account's free versions are already used by other projects, so these bill at $0.06 each, inside the accepted total | about 0.18 (0.24 during a rotation) |
| TF state bucket | us-east1, Always Free (5 GB-months) | 0 |
| Cloud Run `clinic-realtime` (stretch S1) | Free tier in us-east4; 0.25 vCPU per stream; an open stream bills instance time while connected | 0 (deduced; measures one dashboard tab for 30 minutes) |
| Secret Manager, stretch secrets | up to 2 more (realtime DB URL, stream ticket key); total 4 of 6 | 0 |
| Vercel front door (ADR-0023): route handlers in the booking app's project (`clinic-web`) | Hobby; counted in the project's limits, including 1M CDN requests | 0 |
| Cloud Run egress | North America only, first 1 GiB free | 0 (deduced use about 50%) |
| Google OAuth consent screen and client | Free | 0 |
| reCAPTCHA through Google Cloud (ADR-0022) | Free for the first 10,000 assessments a month per organization; a few hundred are expected | 0 (a flat $8 only if the month passes 10,000) |

**Realtime cost arithmetic (stretch S1; superseded by the corrected paragraph below, kept for the record).** With request-based billing an instance is billed for every second it has an open request, so one connected dashboard tab bills about 1 vCPU × 3,600 s = 3,600 vCPU-seconds and 0.25 GiB × 3,600 s = 900 GiB-seconds per connected hour. The monthly free allowance (180,000 vCPU-seconds and 360,000 GiB-seconds per billing account, list figures that pricing check confirms; shared with `clinic-api`) therefore covers about 50 connected hours a month at most; a tab held open 8 h a day passes it within about a week. Above the allowance, at the Tier 1 list price of about $0.000024 per vCPU-second (europe-west3's pricing tier is confirmed in the pricing check), one connected hour costs roughly $0.09 in CPU plus well under $0.01 in memory. The hidden-tab and 10-minute idle closes are what keep this near zero, which is why they are acceptance items. We keep `--cpu 1`: Cloud Run requires a maximum concurrency of 1 below one vCPU (per its docs; confirmed in before relying on it), which would turn every stream into its own instance. The realtime smoke test also records the measured cold first-connect time.

**Realtime cost arithmetic, corrected by the $0 audit (2026-10-16; still a deduction until measures it).** The paragraph above used Tier 1 prices for a Tier 2 region. In europe-west3 the same $4.32 CPU discount covers only about 35 connected hours a month at 1 vCPU, not about 50. In us-east4 (Tier 1) it is about 50 hours at 1 vCPU, which a dashboard held 8 h a day for 7 days (56 h) would exceed on its own. We therefore **reverse the `--cpu 1` choice**: `--cpu 0.25 --concurrency 1 --max-instances 2`. One stream per instance is acceptable for an admin feed with one or two viewers, and the 2-instance cap means at most 2 concurrent streams in total (a third connect is queued by Cloud Run and then refused, deduced to be Cloud Run's own 429 rather than our 503 `STREAM_CAPACITY`, which observes; the dashboard shows "Live feed busy" and keeps its metrics view). `MAX_STREAMS_PER_INSTANCE` becomes 1 to match. Per connected hour that is 900 vCPU-s and 900 GiB-s (0.25 GiB), so 56 connected hours use 50,400 vCPU-s, about 28% of the allowance, leaving room for `clinic-api`. **Amended by the hosting lock review:** 56 hours was not an upper bound, because the idle close is client-side; a script could hold 2 streams all month (1,296,000 vCPU-s). Every stream now needs a ticket, and each ticket debits 700 s from a 345,600 s monthly budget enforced by `clinic-api`, so realtime compute is at most 86,400 vCPU-s and the month's worst case is $2.49 gross, under the $3 budget amount (deduced; the budget only alerts). The "concurrency 1 below 1 vCPU" rule and whether 0.25 vCPU with 256 MiB is an accepted combination are **unverified** and checked in; if 0.25 vCPU is rejected, the fallback is 0.5 vCPU (100,800 vCPU-s for 56 h, still under the allowance with clinic-api) and the cost table is recomputed.

**Amendment (2026-10-18): the $3 budget is alerts-only, not a cap.** Verified in the Cloud Billing console: both clinic budgets show "Spend cap status: Not applicable" and month-to-date gross is $0.02 on each. `google_billing_budget.run_spend_cap_3usd` is alerts-only by construction. A spend cap can only be configured in the console, and an existing budget cannot be converted into one ([Google's spend-cap guide](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)). The decision to bound compute with a cap is therefore **not in force**; the guards that are in force are the platform limits in the first row of the table, IAM-only access, the egress alert and the free-tier arithmetic. Creating a console spend-cap budget has not been approved. Until it is created and shown as "Configured", every use of "spend cap" or "hard" for this budget in this ADR means alerts-only.

**Amendment (2026-10-18): two Vercel projects, and the secret count.** Everything above that says "the `web` project" refers to the booking app's project `clinic-web`; the admin app is the second project `clinic-admin` ([ADR-0027](0027-two-apps-in-a-workspace.md)), and both stay inside Hobby limits. The Secret Manager row counts three secrets (the two database URLs and the internal signing key). In the repository at this commit Terraform declares the two database URL secrets (`infra/terraform/secrets.tf`) and `ship-api` mounts only `DATABASE_URL`; wiring the signing key secret and `ADMIN_EMAILS` into the API deploy is being added by a separate change and is not claimed as landed here. The counted cost does not change.

## Consequences

- Good: scale-to-zero end to end, with nothing billing while idle.
- Bad (option 2, superseded by option 4): EU data residency. That blocks production use with real Kenyan health data under the KDPA. The demo data is synthetic.
- Bad: the cold path (Cloud Run start + Neon wake) is estimated at 1-3 s for the first hit, unmeasured.
- Pending: Neon `max_connections` is recorded in.
- Bad (option 4): longer client hop from Kenya and an extra front-door hop; US data residency instead of EU; Vercel becomes a lean-core dependency (ADR-0023).
- Good (option 4): the full Tier 1 compute allowance and the only Cloud Run egress tier that is free.

## Assessment line

"Deploy to any cloud, public URL".

## Review trigger

More than 10 instances means the Neon pooler with `statement_cache_size=0`, tested first. Real Kenyan data means an African-region database. Any Billing report line above $0.00, a Free Tier savings line approaching its limit, or Google changing a free tier (30 days' notice) means re-running the the cost analysis in ADR-0014 proof before the next deploy. Cloud Monitoring alerting charges start no sooner than 2027-09-01 at $0.35 per metric reference a month (cloud.google.com/stackdriver/pricing, verified by the cost verifier 2026-10-16): before 2027-08-01, delete the egress alert policy and its notification channel, or re-run the cost proof in ADR-0014 with that line.

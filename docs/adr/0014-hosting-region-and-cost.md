# ADR-0014: Hosting, region and cost

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, $0 cost audit: region moved from europe-west3 to us-east4 (Tier 1, North America egress tier), Neon to aws-us-east-1, the edge to an IAM-gated Vercel front door ([ADR-0023](0023-zero-cost-edge-front-door.md)), and every cost line proven against an official free tier in

## Status

Accepted

**Build status (2026-10-18, main 748d7d8): Mostly shipped.** Cloud Run, Artifact Registry and the budgets are in us-east4 behind an IAM-gated front door, with `cost_check.sh` guarding the limits. The web tier is two Vercel apps. The $3 Cloud Run spend cap is Configured and console-managed (since 2026-10-18); the Neon settings are external. The realtime Cloud Run service is superseded by ADR-0031. The Ably key secret exists; the free-tier proof from measured usage is pending.

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
| Cloud Run spend-cap budget, $3 gross, project + Cloud Run service | hard (platform; enforcement "isn't instant"; status "Configured" verified 2026-10-18, console-managed) | Pauses new Cloud Run usage before gross compute reaches the $4.32 Tier 1 CPU discount, so net compute stays $0 |
| No `allUsers` invoker, no `--allow-unauthenticated`, no `--no-invoker-iam-check`; the booking app's proxy and the apps' server calls only (ADR-0023, ADR-0027) | hard (IAM) | Billed egress to non-North-America clients; denied requests are not billed |
| Neon Free, Vercel Hobby, CircleCI Free with no card | hard (plan) | They pause or block at their limits and cannot bill |
| Artifact Registry 2 versions per package + `sizeBytes` < 450 MB assert (raised from 400 MB, amendment 2026-10-18) | configuration | Storage past 0.5 GiB |
| Destroy, never disable, old secret versions; ≤ 6 active asserted | configuration | Secret versions past 6 |
| State bucket in us-east1, lifecycle, soft delete off | configuration | Storage billed outside the Always Free regions |
| Daily egress alert policy (free until at least 2027-09-01; delete or re-audit before 2027-08-01) + kill switch | detection + manual stop | Egress past 1 GiB under a flood |
| One free `_Default` log exclusion, `drop-iam-denied`, for IAM-denied 401 and 403 request logs (widened from 403 only by the hosting lock review; a junk bearer gets 401) | configuration | Log ingestion past 50 GiB under a flood of direct requests |
| $1 alerts-only budget | detection only | Nothing by itself; it tells us something escaped the guards |

The remaining non-capped surfaces (Artifact Registry, Secret Manager, Cloud Storage, egress) are held at $0 by configuration and checks, not by a platform cap. We say that plainly rather than call the budget a cap.

**Amendment, 2026-10-16: the billing account is shared.** The plan assumed a dedicated billing account. None could be opened (5 of 5 slots in use), so `sil-clinic-booking` is linked to the shared "Firebase Payment" account `01C382-12CD13-DCA6EF`, alongside `nanolend-api`, `master-crossing-435409-r1`, `pawacloud-assessment` and `unicorns-484301`. Every per-account free tier is therefore shared. Measured over the last 30 days: the other projects used 63,981 request-based vCPU-s, 11,666 instance-based vCPU-s and 15,610 requests; each billing mode has its own free tier (180,000 and 240,000 vCPU-s), and with this project's worst month the request-based use is 158,381 vCPU-s (headroom 21,619, 12.0%) and $4.08 of its $5.22 discount, instance-based 11,666 vCPU-s and $0.22, so Cloud Run compute stays $0 on observed use, thinly and without a guarantee (the other projects can spend the whole tier on their own, and our spend cap cannot see them). Artifact Registry (about 27.8 GiB held by the others against 0.5 GiB free) and Secret Manager (50 active versions against 6 free) are already past their free tiers, so this project is **not $0**: about $0.28 a month (deduced from list prices and our 400 MB and 4-version bounds). The engineer accepted the about $0.28 a month on 2026-10-16 (option A); compute and egress must stay within the free tier. Consequences applied: the $1 alerts budget is scoped to this project (`infra/billing`, run as the billing user), the project-list check asserts the recorded project list instead of "only this project", and `make shared-headroom` re-measures the others.

**Security amendment, same date.** The default Compute service account holds `roles/editor`. Terraform removes that one binding (`default_sa.tf`), every deploy passes an explicit `--service-account`, and a live check plus a static rule check both.

**Cut for cost.** Anything that could not be proven $0 is out: Europe hosting (Tier 2 compute and egress from byte 0), a public `allUsers` invoker, Artifact Analysis scanning ($0.26 per image, no free tier; trivy in CI instead), Cloud Build and `gcloud run deploy --source`, a state bucket outside the free regions, CircleCI Docker layer caching, Vercel image optimization, uptime pingers. Reasons

**Cost (estimated at demo traffic; observed numbers replace these in the README).** The original table follows, with each line amended by the audit:

| Item | Plan | Est. $/mo |
|---|---|---|
| Cloud Run | Free tier in us-east4 (Tier 1, verified); spend cap $3 gross | 0 |
| Neon | Free | 0 |
| Vercel | Hobby | 0 |
| CircleCI | Free credits (30,000 a month; budget 22,200 worst case) | 0 |
| Artifact Registry | at most 2 versions per package, < 450 MB (free 0.5 GiB; amendment 2026-10-18) | 0 |
| Secret Manager | 3 secrets, 1 active version each (the two database URLs and `clinic-internal-signing-key`, now wired to `clinic-api` with `--set-secrets` and managed in Terraform; 4 versions during a rotation). The shared account's free versions are already used by other projects, so these bill at $0.06 each, inside the accepted total | about 0.18 (0.24 during a rotation) |
| TF state bucket | us-east1, Always Free (5 GB-months) | 0 |
| Cloud Run `clinic-realtime` (stretch S1) | Free tier in us-east4; 0.25 vCPU per stream; an open stream bills instance time while connected | 0 (deduced; measures one dashboard tab for 30 minutes) |
| Secret Manager, stretch secrets | up to 2 more (realtime DB URL, stream ticket key); total 4 of 6 | 0 |
| Vercel front door (ADR-0023): route handlers in the booking app's project (`clinic-web`) | Hobby; counted in the project's limits, including 1M CDN requests | 0 |
| Cloud Run egress | North America only, first 1 GiB free | 0 (deduced use about 50%) |
| Google OAuth consent screen and client | Free | 0 |
| reCAPTCHA through Google Cloud (ADR-0022) | Free for the first 10,000 assessments a month per organization; a few hundred are expected | 0 (a flat $8 only if the month passes 10,000) |

**Realtime cost arithmetic (stretch S1; superseded by the corrected paragraph below, kept for the record).** With request-based billing an instance is billed for every second it has an open request, so one connected dashboard tab bills about 1 vCPU × 3,600 s = 3,600 vCPU-seconds and 0.25 GiB × 3,600 s = 900 GiB-seconds per connected hour. The monthly free allowance (180,000 vCPU-seconds and 360,000 GiB-seconds per billing account, list figures that pricing check confirms; shared with `clinic-api`) therefore covers about 50 connected hours a month at most; a tab held open 8 h a day passes it within about a week. Above the allowance, at the Tier 1 list price of about $0.000024 per vCPU-second (europe-west3's pricing tier is confirmed in the pricing check), one connected hour costs roughly $0.09 in CPU plus well under $0.01 in memory. The hidden-tab and 10-minute idle closes are what keep this near zero, which is why they are acceptance items. We keep `--cpu 1`: Cloud Run requires a maximum concurrency of 1 below one vCPU (per its docs; confirmed in before relying on it), which would turn every stream into its own instance. The realtime smoke test also records the measured cold first-connect time.

**Realtime cost arithmetic, corrected by the $0 audit (2026-10-16; still a deduction until measures it).** The paragraph above used Tier 1 prices for a Tier 2 region. In europe-west3 the same $4.32 CPU discount covers only about 35 connected hours a month at 1 vCPU, not about 50. In us-east4 (Tier 1) it is about 50 hours at 1 vCPU, which a dashboard held 8 h a day for 7 days (56 h) would exceed on its own. We therefore **reverse the `--cpu 1` choice**: `--cpu 0.25 --concurrency 1 --max-instances 2`. One stream per instance is acceptable for an admin feed with one or two viewers, and the 2-instance cap means at most 2 concurrent streams in total (a third connect is queued by Cloud Run and then refused, deduced to be Cloud Run's own 429 rather than our 503 `STREAM_CAPACITY`, which observes; the dashboard shows "Live feed busy" and keeps its metrics view). `MAX_STREAMS_PER_INSTANCE` becomes 1 to match. Per connected hour that is 900 vCPU-s and 900 GiB-s (0.25 GiB), so 56 connected hours use 50,400 vCPU-s, about 28% of the allowance, leaving room for `clinic-api`. **Amended by the hosting lock review:** 56 hours was not an upper bound, because the idle close is client-side; a script could hold 2 streams all month (1,296,000 vCPU-s). Every stream now needs a ticket, and each ticket debits 700 s from a 345,600 s monthly budget enforced by `clinic-api`, so realtime compute is at most 86,400 vCPU-s and the month's worst case is $2.49 gross, under the $3 spend cap (deduced). The "concurrency 1 below 1 vCPU" rule and whether 0.25 vCPU with 256 MiB is an accepted combination are **unverified** and checked in; if 0.25 vCPU is rejected, the fallback is 0.5 vCPU (100,800 vCPU-s for 56 h, still under the allowance with clinic-api) and the cost table is recomputed.

**Amendment (2026-10-18): the $3 budget was alerts-only until today (history); it is now a real spend cap.** What was true earlier on 2026-10-18: Verified in the Cloud Billing console: both clinic budgets show "Spend cap status: Not applicable" and month-to-date gross is $0.02 on each. `google_billing_budget.run_spend_cap_3usd` is alerts-only by construction. A spend cap can only be configured in the console, and an existing budget cannot be converted into one ([Google's spend-cap guide](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)). The decision to bound compute with a cap is therefore **not in force**; the guards that are in force are the platform limits in the first row of the table, IAM-only access, the egress alert and the free-tier arithmetic. Creating a console spend-cap budget had not yet been approved.

**Resolved (2026-10-18, user-approved, console-verified).** The Terraform alerts-only budget was deleted and a console spend-cap budget was created under the same name `clinic-run-spend-cap-3usd` (`BUDGET_ID=bfd734ab-ef98-414a-8bb1-b6442c1dec94`): $3 gross, Cloud Run scope, thresholds 0.5, 0.8 and 1.0, "Spend cap status: Configured". It is console-managed, not Terraform. Spend caps allow one budget per project and service, and the console refused to create it while the alerts-only budget existed, so the old one had to go first. An enforced cap resets monthly, and enforcement is not instant. The cap is a last-resort backstop: the $0 mechanism is the free-tier arithmetic plus the realtime ticket budget, not the cap. The table row above reads "hard" again because that is now verified; the console observation is recorded in [docs/evidence/spend-cap-2026-10-18.md](../evidence/spend-cap-2026-10-18.md).

**Amendment (2026-10-18): two Vercel projects, and the secret count.** Everything above that says "the `web` project" refers to the booking app's project `clinic-web`; the admin app is the second project `clinic-admin` ([ADR-0027](0027-two-apps-in-a-workspace.md)), and both stay inside Hobby limits. The Secret Manager row counts three secrets (the two database URLs and the internal signing key). On main Terraform declares the signing key secret `clinic-internal-signing-key` next to the two database URL secrets (`infra/terraform/secrets.tf`), and `ship-api` mounts it with `DATABASE_URL` and sets `ADMIN_EMAILS` as an environment variable. The counted cost does not change.

**Amendment (2026-10-18): realtime push adds a secret.** [ADR-0031](0031-realtime-push-via-ably-sse.md) adds the Secret Manager secret `clinic-ably-api-key`, making four secrets (the two database URLs, the internal signing key and the Ably key). The approved cost ceiling moves from about $0.28 to about $0.34 a month (one more version at $0.06, deduced from the same list price as the 0.18 line). The Ably free package (200 concurrent connections, 6M messages a month, per Ably's pricing pages) is a free-tier claim not yet proven on this project: the proof is pending measured usage. Ably documents what happens at the connection and channel caps but not at the monthly message cap, so the message volume is bounded by us (a publish cap, an 80% stats alarm and no payment method on the account, engineer-verified 2026-10-18; see ADR-0031), not by an assumed provider limit. The Cloud Run spend cap stays a last-resort backstop, not the $0 mechanism. The realtime Cloud Run service and its ticket budget in the text above are superseded by ADR-0031 and will not be built.

**Update, same day (2026-10-18): the secret and the account exist.** The secret `clinic-ably-api-key` now exists with one enabled version, and the Ably account is on the Free package with no payment method (evidence: [docs/evidence/ably-no-payment-method-2026-10-18.md](../evidence/ably-no-payment-method-2026-10-18.md)). The heading above says "pending build" because it was written first; the relay and the token endpoints that use the secret shipped in PR #39; the booking page subscription in PR #44. The free-tier proof from measured usage is still pending.

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

**Amendment, 2026-10-17: the internal signing key reaches the API.** `clinic-internal-signing-key` already existed in Secret Manager with one version; Terraform now adopts it (an `import` block, removed after the first apply) and grants `clinic-api-runtime` `roles/secretmanager.secretAccessor` on that one secret. `ship-api` passes it as `INTERNAL_SIGNING_KEY` and sets `ADMIN_EMAILS`. The secret count stays at 3 (the table above already counted it), so Secret Manager remains about $0.18 a month, $0.24 during a rotation (3 versions at $0.06; 4 while the old one is destroyed), and the accepted total with Artifact Registry stays about $0.28 to $0.34 a month. Nothing new is always-on and no value is in state.

**Amendment, 2026-10-18: the Artifact Registry size bound goes from 400 MB to 450 MB.** This is a bound raise, not a fix of the size. Artifact Registry reports the repository `clinic` at 417.198 MB (repository `sizeBytes`, updated 2026-10-18 18:30:57 UTC), while the version list holds only two images of about 64.1 MB each (`sha-3f41e81`, `sha-36c4cb1`). About 290 MB is unexplained; the likely cause is a size that lags behind the pruning, but that is unconfirmed. The image itself is already close to minimal. Arithmetic: Artifact Registry storage costs $0.10 per GB-month, so 0.05 GB more is about $0.005 a month, and the total stays about $0.34 a month, inside the approved ceiling. 450 MB is still under the 0.5 GiB (536.9 MB) free allowance this project would otherwise exceed. `scripts/cost_check.sh` keeps the bound in the single constant `AR_SIZE_BOUND_BYTES`, with selftest cases just under and just over it.

Review trigger for this bound: if the repository `sizeBytes` still reads far above the sum of the kept images after the next prune, investigate stale blobs instead of raising the bound again. A reproducible build (a deterministic virtual-environment layer) would also stop each release adding about 20 MB of layers that cannot be deduplicated.

**Amendment, 2026-10-19: the Artifact Registry check is a cost ceiling worked out from the live secret count.** This supersedes the 2026-10-18 amendment above. The raise from 400 MB to 450 MB never took effect: the live check still compared against a hard-coded 400,000,000, and `cost-check` C5 failed on the releases for `6554ed1` and `ceb7f00`. Also superseded by this amendment, wherever they appear above: the Decision-section line that `cost-check` asserts `sizeBytes` is below 400,000,000; the "Storage past 0.5 GiB" entry in the table of guards; and the secret counts of three and four, which are now five (see below). Earlier text is left as written.

What was held on 2026-10-18 at 21:46 UTC (read-only `gcloud` and the registry API, project `sil-clinic-booking`): repository `sizeBytes` 459,971,361; two versions of `clinic-api`, `metadata.imageSizeBytes` 64,099,567 and 64,099,397 (128,198,964 together; the images share layers, so the sum is larger than the layers they need); 144 files, of which 142 blobs. The two manifests reference 18 blobs, 84,939,676 bytes. The other 126 blobs, 375,031,685 bytes, belong to no kept image; each was created between 13:03 and 20:23 UTC that day, and the largest (about 20.76 MB each) is the virtual-environment layer that every build produces anew. Later that evening `sizeBytes` read 501,652,027 with the same two kept images: it follows how many releases landed since the registry last reclaimed layers.

What the documentation says (read 2026-10-19). Deletion: "Deleting images doesn't immediately delete the referenced layers. Unreferenced layers are deleted daily." (docs.cloud.google.com/artifact-registry/docs/docker/manage-images); cleanup policies "take effect within approximately one day" (docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy). Price (the page text of cloud.google.com/artifact-registry/pricing): "Artifact Registry Storage 0 gibibyte month to 0.5 gibibyte month $0.00 (Free) ... 0.5 gibibyte month and above $0.000136986 / 1 gibibyte hour, per 1 month / account." The free half gibibyte is per account, and this project shares its account with projects that use it up, so none of our storage is free: $0.000136986 x 730 hours is $0.10 per GiB-month. The documentation does not say how `sizeBytes` is computed; the check assumes layers waiting to be reclaimed are billed, the conservative reading.

The approved total. It was about $0.34 a month (the figure the earlier amendments above keep as history). On 2026-10-19 the engineer approved $0.50 a month instead, after the check showed the old figure could not hold: Secret Manager costs $0.06 per active version, C7 counts them live, and there are five secrets with one version each (`clinic-ably-api-key`, `clinic-database-url-app`, `clinic-database-url-migrate`, `clinic-internal-signing-key`, `clinic-smoke-signing-key`), so $0.30. The registry share of $0.34 would have been $0.04, 0.4 GiB, and the registry was already above it. $0.50 is far below the $3 spend cap, which stays a backstop and is not the cost mechanism.

The ceiling. Registry ceiling = ($0.50 - versions x $0.06) / $0.10 per GiB, computed by `scripts/cost_check.sh` from the live version count on every run: 5 versions give ($0.50 - $0.30) / $0.10 = 2 GiB = 2,147,483,648 bytes; 4 versions give 2.6 GiB (2,791,728,742 bytes); 6 versions give 1.4 GiB (1,503,238,553 bytes); 9 or more leave nothing. A new secret therefore lowers the ceiling, and a count that cannot be read fails the check instead of being taken as zero.

Today's figures. At the last read the repository `sizeBytes` was 564,212,306 bytes. Bytes to GiB to dollars: 564,212,306 / 1,073,741,824 = 0.5255 GiB, times $0.10 = about $0.053. With the five secret versions that is about $0.35 a month, against the $0.50 ceiling. Adding the two Go images at the 25 MB cap (50,000,000 bytes, 0.047 GiB, about $0.005) gives about $0.36. The check passes with 1,533,271,342 bytes of headroom after that projection. The headroom depends on release cadence: each release adds about 21 MB that cannot be shared, reclaimed about a day later, so even thirty releases in one day (630 MB) leave room.

The Go gateway (#71) is not in the registry. Until a `clinic-realtime` package exists, the check adds two Go images at 25,000,000 bytes each to `sizeBytes`. 25 MB is the cap the Go build is meant to enforce, not a measured size; replace it with the measured size when the image is built. The kept-images bound of 200,000,000 bytes (2 x 64.1 MB for the API plus 2 x 25 MB for Go, 178.2 MB rounded up) already budgets for that unbuilt image, and summing `imageSizeBytes` counts shared layers once per image, which over-counts (the conservative direction).

C5 therefore checks: the cleanup policies; `sizeBytes` plus the not-yet-pushed Go images under the ceiling worked out above, with the headroom printed on every run; the sum of the kept versions' sizes within 200,000,000 bytes, with an empty image list a failure; and, as a note rather than a judgement, the difference between the two. The comparison goes through helpers and named constants, rejects leading-zero and oversized numbers, and the selftest runs the live check end to end against stand-in `gcloud` and `curl` to show that no threshold is hidden in it (that is how this incident would have been caught).

The CI identity. The deployer holds `roles/artifactregistry.writer` on the `clinic` repository (read from the repository's IAM policy on 2026-10-19), and that role's permission list includes `artifactregistry.dockerimages.list` (read with `gcloud iam roles describe`). That is proven from the policy, not by a call made as the deployer: impersonating it from here is refused, and the Policy Troubleshooter API is not enabled in the project. Its `artifacts versions list` call (C6) passes in CI. If the images call is refused in CI, C5 fails with a message naming the missing permission and printing no account. What remains unproven is the first CI run of that one call.

Nothing was deleted: the registry reclaims the layers itself, and removing blobs by hand is destructive and would race the next release.

Review trigger: if `sizeBytes` is still far above the kept images' sizes more than two days after the last release, look for stale blobs instead of raising a number. A reproducible build (a deterministic virtual-environment layer) would stop each release adding about 20 MB that cannot be shared.

# Resolved versions & platform facts (WP-00)

Every row has a **value**, a **source** (command or URL) and a **date**. No row says
"assumed". Rows whose value is a documented deduction say **DEDUCED** and name the gate
that confirms them later. Facts labelled `local` were observed on this machine; CI pins the
same values so the lockfile format agrees.

Resolution date for the whole file unless a row states otherwise: **2026-10-16**.

---

## 1. Language runtimes & local tool versions

| Thing | Value | Source | Date |
|---|---|---|---|
| Python | 3.12.13 | `python3 --version` (local) | 2026-10-16 |
| uv | 0.11.28 | `uv --version` (local); CI pins `pip install uv==0.11.28` | 2026-10-16 |
| Node.js | v24.14.0 | `node --version` (local) | 2026-10-16 |
| pnpm | 12.5.1 | `pnpm --version` (local) | 2026-10-16 |
| Docker Engine | 29.8.2 | `docker --version` (local) | 2026-10-16 |
| Go (STRETCH S1) | 1.26.5 | `go version` (local, darwin/arm64); CI installs `go<ver>.linux-amd64.tar.gz` with published sha256 | 2026-10-16 |
| CircleCI CLI | 1.6.0 | `circleci version` (local) | 2026-10-16 |

## 2. Python package pins (runtime + dev)

Resolved by `curl https://pypi.org/pypi/<pkg>/json | .info.version` (equivalent to
`pip index versions`), 2026-10-16. All match the WP-00 planning resolution.

| Package | Version | Date |
|---|---|---|
| fastapi | 0.143.2 | 2026-10-16 |
| sqlalchemy | 2.1.4 | 2026-10-16 |
| uvicorn | 0.54.0 | 2026-10-16 |
| asyncpg | 0.32.0 | 2026-10-16 |
| alembic | 1.20.0 | 2026-10-16 |
| pydantic | 2.14.1 | 2026-10-16 |
| pydantic-settings | (latest compatible with pydantic 2.14.1; pinned in `uv.lock`) | 2026-10-16 |
| schemathesis | 4.31.1 | 2026-10-16 |
| semgrep | 1.181.0 | registry (WP-00 planning), CI only | 2026-10-16 |
| pip-audit | 2.10.1 | 2026-10-16 |
| pyjwt | 2.15.1 | registry (WP-00 planning); unused in v1 | 2026-10-16 |

## 3. Node package pins

Resolved by `curl https://registry.npmjs.org/<pkg>/latest | .version`, 2026-10-16. All match
the WP-00 planning resolution.

| Package | Version | Date |
|---|---|---|
| next | 16.4.2 | 2026-10-16 |
| react | 19.3.1 | 2026-10-16 |
| @tanstack/react-query | 5.104.3 | 2026-10-16 |
| zod | 4.6.7 | 2026-10-16 |
| @hey-api/openapi-ts | 0.99.0 | 2026-10-16 |
| shadcn | 4.21.5 | registry (WP-00 planning) | 2026-10-16 |
| next-themes | 0.4.6 | 2026-10-16 |

**Correction (WP-00):** `@hey-api/client-fetch` is deprecated. Since openapi-ts 0.73.0 it is
bundled into `@hey-api/openapi-ts` (npm deprecation notice), so it is **not** installed
separately. The plugin name `@hey-api/client-fetch` stays in the codegen config.

**next-auth (STRETCH S3):** `npm view next-auth dist-tags` on 2026-10-16: `latest` is `4.24.15`;
v5 exists only as `beta` `5.0.0-beta.32`. S3 as designed pins a beta (recorded as TD27 / K34).

## 4. Container images (pinned by digest)

Resolved by `docker buildx imagetools inspect <ref>`, 2026-10-16. `mirror.gcr.io/library/*`
returned the **identical** digest to `docker.io/library/*` for both images, confirming the
mirror can be pinned by the same digest.

| Image | Digest | Source | Date |
|---|---|---|---|
| python:3.12-slim | `sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1` | `docker buildx imagetools inspect python:3.12-slim` | 2026-10-16 |
| postgres:17-alpine | `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` | `docker buildx imagetools inspect postgres:17-alpine` | 2026-10-16 |
| mirror.gcr.io/library/python:3.12-slim | same digest as above | `docker buildx imagetools inspect mirror.gcr.io/library/python:3.12-slim` | 2026-10-16 |
| mirror.gcr.io/library/postgres:17-alpine | same digest as above | `docker buildx imagetools inspect mirror.gcr.io/library/postgres:17-alpine` | 2026-10-16 |
| ghcr.io/zaproxy/zaproxy:stable | `sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6` | `docker buildx imagetools inspect ghcr.io/zaproxy/zaproxy:stable` | 2026-10-16 |

Base digest is **not** frozen until feature freeze (Wed 21 Oct 20:00 EAT, §8 schedule);
these are the current digests, re-resolved at freeze.

## 5. CI images

| Image | Value | Source | Date |
|---|---|---|---|
| cimg/python (backend-test primary) | `cimg/python:3.12` (tracks 3.12.x; `3.12.13` available, matches local) | Docker Hub tags API | 2026-10-16 |
| cimg/postgres (backend-test secondary) | `cimg/postgres:17.11` (latest 17.x) | Docker Hub tags API | 2026-10-16 |
| Docker Official Images in CI | pulled from `mirror.gcr.io/library/...` by digest; `dockerhub-ro` context as login fallback | ADR-0016, §8 rule 11 | 2026-10-16 |

## 6. Security tool versions

| Tool | Value | Source | Date |
|---|---|---|---|
| gitleaks | 8.30.1 | `gitleaks version` (local); matches plan pin | 2026-10-16 |
| gitleaks pre-commit subcommand | `gitleaks git --pre-commit --staged` | `gitleaks git --help` on 8.30.1 confirms both flags under the `git` subcommand | 2026-10-16 |
| trivy | plan pin 0.76.0 (CI); **local is 0.72.0** | `trivy --version` (local). Trivy runs only in CI/WP-13, pinned there; local mismatch is non-blocking | 2026-10-16 |
| semgrep | 1.181.0 (CI only; not installed locally) | registry (WP-00 planning) | 2026-10-16 |
| ZAP | `ghcr.io/zaproxy/zaproxy:stable` @ digest above | buildx imagetools | 2026-10-16 |

## 7. CircleCI platform facts (doc reads)

| Fact | Value | Source | Date |
|---|---|---|---|
| OIDC V2 claim names | `oidc.circleci.com/project-id`, `oidc.circleci.com/vcs-ref` | CircleCI OIDC docs (WP-00 planning read) | 2026-10-16 |
| Context expression restrictions (Free plan) | contexts usable; restrict to `main`; no org-level security group gating needed for this scope | CircleCI contexts docs (WP-00 planning read) | 2026-10-16 |
| `serial-group` | supported for release serialization | CircleCI workflow docs (WP-00 planning read) | 2026-10-16 |
| GitHub App trigger | pipeline triggers via GitHub App integration | CircleCI docs (WP-00 planning read) | 2026-10-16 |
| CI egress region | jobs run on AWS `us-east-1`/`us-east-2`, GCP `us-east1`/`us-central1` → North America (DEDUCED egress location; the egress IP itself is undocumented, so the **C19 gate** checks `ipinfo.io/country = US` on every release) | circleci.com/docs/guides/security/ip-ranges, last updated 2026-09-28, read 2026-10-16 | 2026-10-16 |

## 8. Cloud Run / GCP / cost facts (§13.1 $0 audit; doc reads 2026-10-16)

Region: **us-east4** (Tier 1, North America free egress SKU). State bucket: **us-east1**
(Cloud Storage Always Free region). europe-west3 is Tier 2 and was rejected (ADR-0014).

| Ref | Fact | Value | Source | Date |
|---|---|---|---|---|
| (a) | `--cpu 0.25 --memory 256Mi --concurrency 1` | accepted; concurrency must be 1 below 1 vCPU | Cloud Run CPU/memory limits docs | 2026-10-16 |
| (b) | custom audience on a tag URL | `--add-custom-audiences` accepted | Cloud Run docs | 2026-10-16 |
| (c) | spend-cap budget via Terraform | `google_billing_budget` creates the budget; the **spend-cap action** field is unverified → confirmed by console screenshot in `docs/runbooks/bootstrap-gcp.md`; eligibility checked at bootstrap | Cloud Billing budget docs | 2026-10-16 |
| (d) | Cloud Run sent-bytes metric | `run.googleapis.com/container/network/sent_bytes_count` | Cloud Monitoring metrics list | 2026-10-16 |
| (e) | bucket soft-delete off | `gcloud storage buckets create --soft-delete-duration=0` accepted; soft-deleted bytes otherwise bill as storage | Cloud Storage docs | 2026-10-16 |
| (f) | Vercel client-IP header / Hobby limits | Hobby default & max function memory = 2 GB / 1 vCPU, duration 300 s default & max ("including streamed responses"); `vercel env pull` writes a dev `VERCEL_OIDC_TOKEN` | vercel.com/docs/functions/limitations, last updated 2026-08-24, read 2026-10-16 | 2026-10-16 |
| (g) | Artifact Registry cleanup-policy JSON keys | `keepCount`, `olderThan`, `tagState` | Artifact Registry cleanup-policy docs | 2026-10-16 |
| (h) | Semgrep rulesets without login | `p/python`, `p/typescript`, `p/owasp-top-ten` run without login (`--metrics=off`, no `SEMGREP_APP_TOKEN`); if a ruleset demands login, vendor a local copy | Semgrep registry docs | 2026-10-16 |
| (i) | AR→Cloud Run intra-`us-east4` image pull charge | expected none (**DEDUCED**; pricing page network section could not be read this pass). Precondition of WP-12's first deploy: if unread, first release ships and no further release runs until **C17** shows no Artifact Registry egress line after 48 h | cloud.google.com/artifact-registry/pricing + Billing Catalog | 2026-10-16 |
| (j) | `gcloud run services describe --format=json` annotation paths | `run.googleapis.com/invoker-iam-disabled` under service `metadata`; `run.googleapis.com/cpu-throttling`; service-level `autoscaling.knative.dev/minScale`; `run.googleapis.com/scalingMode` under `metadata.annotations` (values `manual`/`automatic`, absent = automatic) | docs.cloud.google.com/run/docs/securing/managing-access; .../configuring/services/manual-scaling, read 2026-10-16 | 2026-10-16 |
| (k) | buildx push with vs without `--provenance=false --sbom=false` | with the flags: one manifest (one AR version). Without: an index + attestation manifests (multiple versions). Build always passes both flags | docker buildx docs | 2026-10-16 |
| manual-scaling ban | `--scaling` (any value) switches to manual scaling, whose instances bill while idle | docs.cloud.google.com/run/docs/configuring/services/manual-scaling, read 2026-10-16 | 2026-10-16 |
| `--no-traffic` on new service | resolved at WP-11 Part B against the live service (deploy uses create-then-tag; recorded there) | Cloud Run docs | 2026-10-16 |

## 9. Neon / Vercel

| Fact | Value | Source | Date |
|---|---|---|---|
| Neon project region | aws-us-east-1, 0.25 CU fixed (min=max), database `clinic` | §11.1 Q6; confirmed by C13 at bootstrap | 2026-10-16 |
| Neon `max_prepared_transactions` | deferred: resolved live at the WP-S1a precondition (stretch; not in lean-core WP-00 scope), expected `0` | STRETCH WP-S1a precondition | 2026-10-16 |
| Vercel plan | Hobby, team `eric-gitangus-projects`, project `clinic-web`, region `iad1`, git deploys off | §11.1 Q4/Q16; confirmed by C15 | 2026-10-16 |

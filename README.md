# Clinic Booking API

<!-- one-line pitch --> · CircleCI badge (main) · tag v1.0.0 @ &lt;sha&gt;

> Work in progress: sections are filled in as the corresponding work lands. The AI
> reflection (section 11) is written by the engineer; nothing here is auto-generated.

## 1. Live URLs

<!-- WEB landing page · API base · Swagger · ReDoc · openapi.json · booking UI (if shipped) · CircleCI pipelines -->

## 2. Verify the claims in 10 minutes

<!-- Step 0: create your own patient · Swagger walkthrough · `make verify URL=...` · `make test-race` -->

## 3. System design

<!-- 3.1 context/container · 3.2 ERD · 3.3 slots · 3.4 concurrency guarantee · 3.5 state machine · 3.6 time model · 3.7 UI freshness -->

## 4. Key decisions & trade-offs

<!-- decision -> trade-off -> review trigger -> ADR link. 4.1 deferred · 4.2 rejected · 4.3 tRPC/gRPC/TanStack · 4.4 stretch tier -->

## 5. API reference & error catalogue

<!-- endpoint table · status rule (404/422/409) · code -> status -> when (docs/api-errors.md) -->

## 6. Code structure

## 7. Testing

<!-- pyramid · race-test assertions · observed coverage % · how to run each layer -->

## 8. Ambiguities & decisions

## 9. Deployment & CI/CD

<!-- which branch deploys · pipeline steps · OIDC/WIF · migrations-first · tagged smoke + promote-by-tag · rollback · VERCEL_TOKEN debt -->

## 10. Operations, cost & security posture

**Cost disclosure.** The GCP project shares a billing account with other projects, whose use has already exhausted the shared Artifact Registry and Secret Manager free tiers, so this project bills about $0.28 a month there (accepted); Cloud Run compute and egress stay within the free tier.

<!-- cost table · latency · $0 proof (see docs/) · no-auth IDOR statement · phone-exists oracle · tech debt ledger · honest hours -->

## 11. AI reflection

### What I used AI for
<!-- ENGINEER: factual bullets + a per-WP table of how much code was agent-generated vs hand-written -->

### An example where AI improved my work
<!-- ENGINEER: verbatim prompt from the exported session transcript (prompt id from the AI usage summary in README §11), what changed, commit SHA -->

### An example where AI was wrong or incomplete, and how I caught it
<!-- ENGINEER: a real entry with its source; how it was caught (test / doc / observation); fix commit -->

### Two decisions I made without AI, and why
<!-- ENGINEER: decision 1 -- must predate or override AI output; cite the message/commit -->
<!-- ENGINEER: decision 2 -- same rule -->

### Note on commits

AI usage is summarized here in §11; commit messages carry no tooling trailers by convention.

## 12. Run locally

<!-- `make up` · `make test` · env vars table · prerequisites (Docker, uv, pnpm) -->

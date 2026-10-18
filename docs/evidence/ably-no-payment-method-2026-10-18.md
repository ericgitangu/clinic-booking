# Evidence: Ably account has no payment method (2026-10-18)

Supports [ADR-0031](../adr/0031-realtime-push-via-ably-sse.md): the Ably message cap is bounded by us, and one of the bounds is that the account holds no payment method, so usage past the free package cannot be billed.

## What was observed

- **Dashboard (observed by the gatekeeper and the engineer on 2026-10-18; not observed by the author of this file):** the Ably account is on the Free package at $0. Its Billing section has only "Package" and "Usage". There is no payment-method or card page.
- **Documentation (re-fetched 2026-10-18 from <https://ably.com/docs/platform/pricing/free>):** "No credit card is required to sign up and there's no time limit on how long you can try it for." The free package limits on that page are 500 messages per second, 6,000,000 messages per month, 200 concurrent channels and 200 concurrent connections.
- **Limits page (read 2026-10-18, <https://ably.com/docs/platform/pricing/limits>):** it says nothing about a payment method, and nothing about rejecting messages at the monthly cap.

## What was set up (names and capabilities only; no key values or key ids)

| Item | Detail |
|---|---|
| App `clinical-booking-prod` | Production Ably app. |
| Key `clinic-api-publish` | Publish and Subscribe, restricted to channels `slots:*` and `admin:*`. |
| Key `clinic-stats` | Statistics only. |
| App `clinic-booking-ci` | CI-only Ably app. |
| Key (CI) | Publish, Subscribe and History; no stats. |
| Secret Manager secret `clinic-ably-api-key` | One enabled version. |
| CircleCI context `ably-ci` | Holds `ABLY_API_KEY` (the CI app's key). |
| CircleCI context `gcp-deploy` | Additionally holds `ABLY_STATS_KEY` (the `clinic-stats` key). |

The Secret Manager and CircleCI entries are as reported by the gatekeeper; they were not re-read for this file.

## What this does not prove

The other bounds in ADR-0031 (the 25,000 a month publish cap, the 80 percent stats alarm) are build items and are not evidenced here.

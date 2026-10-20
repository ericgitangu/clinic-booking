# Evidence: patient live push is on in production (2026-10-18)

Supports [the polling then push decision](https://clinic.ericgitangu.com/decisions#polling-then-push) and . A real production observation at about 13:55 UTC, after the release of main 748d7d8. I did not make these observations; I recorded them as given.

## The release

`ship-api`, `cost-check`, `ship-booking` and `ably-real` succeeded. `ship-admin` failed because `VERCEL_ADMIN_TOKEN` has not been added to the `vercel-prod` context yet, so `verify-release`, `smoke-public` and `zap-prod` did not run.

## The token endpoint, through the public proxy

`POST https://clinic.ericgitangu.com/api/realtime/token/patient`:

- With the site `Origin`: HTTP 200, `Cache-Control: no-store`, and a body with the fields `channel`, `expires_at`, `stream_url`, `token` and `ttl_seconds`.
- With a cross-site `Origin`: HTTP 403.

No token value is recorded here.

## The booking page in a real Chrome

On `/book/<doctor>?date=2026-10-21` (Dr. Achieng Otieno) the page rendered 16 slot chips and two always-mounted `role=status` regions.

- On load: `data-stream="polling"` and `data-polling="armed"`. No token is minted before the person acts, by design.
- After one scroll and one key press: `data-stream="live"`, meaning the token was minted and the stream connected to Ably.

## What this shows and does not show

Patient live push is on in production. At the time of this check the admin live feed was descoped; the Go service that now serves it came later in PR 71 ([the Go decision](https://clinic.ericgitangu.com/decisions#go)). This does not show the push of a real booking by a second visitor reaching a first one's page in production; the the live push CI scenarios cover that against the real service, and the +4 message count in the earlier check covers the publish side.

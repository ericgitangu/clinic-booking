# Runbook: the admin app and who may use it

The admin app (`apps/admin`, Vercel project `clinic-admin`, host `clinic-admin.ericgitangu.com`) shows the clinic dashboard. Who may open it is decided by role: `owner`, `admin` or `viewer` (see ADR-0030). The owner is the address in `ADMIN_EMAILS`; everyone else is added by the owner on the Access page.

## Variables

Vercel project `clinic-admin`, Production. Set sensitive values with `vercel env add NAME production --sensitive` and never write them to a file.

| Name | Sensitive | What it is |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | Signs and encrypts the session cookie. 32 or more random characters. |
| `BETTER_AUTH_URL` | no | `https://clinic-admin.ericgitangu.com` |
| `GOOGLE_CLIENT_ID` | no | The OAuth client; its redirect URI is `<BETTER_AUTH_URL>/auth/callback/google`. |
| `GOOGLE_CLIENT_SECRET` | yes | The OAuth client secret. |
| `ADMIN_EMAILS` | no | The owner's address, `developer.ericgitangu@gmail.com`. Comma separated for more than one owner. |
| `INTERNAL_SIGNING_KEY` | yes | Signs the app-to-API assertion. 32 or more characters. The same value as on the API. |
| `API_URL` | no | The Cloud Run URL of `clinic-api`. |
| `GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL` | no | Identity federation to Cloud Run, as for the booking app, with the `clinic-admin` service account. |

The API (Cloud Run `clinic-api`) needs `INTERNAL_SIGNING_KEY` (from Secret Manager) and `ADMIN_EMAILS` (the same value as the app). Without `INTERNAL_SIGNING_KEY` every `/internal/*` call is refused. The migration `0003` needs a role that may run `CREATE EXTENSION citext`.

## Live check, once after the first deploy

This is the one step no automated test can do, because it uses Google itself. The engineer does it on production:

1. Open `https://clinic-admin.ericgitangu.com` in a private window. The sign-in page shows.
2. Choose Sign in with Google and use `developer.ericgitangu@gmail.com`. You land on the dashboard and the bar shows the Owner role.
3. Open Access. The owner row says "Fixed by configuration".
4. Sign out. Sign in with any other Google account: the page says you do not have access (a 403), and nothing from the dashboard is visible.
5. As the owner, add that second account as Viewer, reload as that account and confirm the dashboard opens but there is no Access link. Revoke it and confirm the next click is refused.

If step 2 fails with a redirect error, the redirect URI in the Google client does not match `BETTER_AUTH_URL`.

## Granting and revoking

Use the Access page: add an email with a role, change a role, or revoke. A revoke applies on the person's next click. Every change is recorded in `staff_access_audit`:

```sql
SELECT occurred_at, actor_email, action, target_email, old_role, new_role
FROM staff_access_audit ORDER BY occurred_at DESC LIMIT 20;
```

## Rotating the signing key

Add a new secret version, update `INTERNAL_SIGNING_KEY` in Vercel, redeploy both the API and the app, then destroy the old version. Calls fail for a few minutes in between, which is accepted.

## Running the end-to-end suite locally

`make e2e-admin` starts the compose API and Postgres with throwaway secrets, builds the app and runs Playwright against them. It uses the real app, API and database; only Google's sign-in is replaced.

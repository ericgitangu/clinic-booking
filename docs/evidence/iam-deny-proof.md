# IAM deny-proof evidence (keyless deploy, IAM-only Cloud Run)

Status: **TEMPLATE, no production run recorded yet.** The sections below hold the record format
and a local dry run against stand-ins. The first release (run-app probe) and the first push of
the `test/wif-deny` branch (wif and context probes) produce the real records as CircleCI
artifacts; copy them in as described in `README.md`.

What each probe proves:

| Probe | Claim | Where it runs |
|---|---|---|
| `run-app` | the direct Cloud Run URL refuses anonymous callers (403) and a junk bearer (401), so no public Cloud Run exists to bill egress | `smoke-public`, after every release |
| `wif` | the STS token exchange from the empty `oidc-probe` context is refused, so a branch build cannot obtain deploy credentials | `wif-deny-probe` on branch `test/wif-deny` (needs the `oidc-probe` context from the bootstrap runbook) |
| `context` | none of the `gcp-deploy` or `vercel-prod` variables exist in a job outside those contexts | same job as `wif` |

## Production records

### run-app

TEMPLATE: not yet produced. Replace with the artifact `evidence/iam-deny-run-app.txt` of the first
`smoke-public` run on main.

### wif

TEMPLATE: not yet produced. Replace with the artifact `evidence/iam-deny-wif.txt` of the first
`wif-deny-probe` run.

### context

TEMPLATE: not yet produced. Replace with the artifact `evidence/iam-deny-context.txt` of the same run.

## Local dry run (stand-in, not production)

Produced at 2026-10-17T21:22Z (the engineer's 2026-10-18) by running the real script against a local HTTP stand-in that answers like
Cloud Run (403 anonymous, 401 junk bearer) and like Google STS (403 `unauthorized_client`). It proves
the record format and the redaction, not any claim about production. The `context` record is a real
run with none of the variables set.

### run-app (stand-in server)

```text
# deny-proof probe record (redacted)
mode=run-app
time_utc=2026-10-17T21:22:00Z
commit=unknown
pipeline=local
target=direct run.app URL (no front door)
probe=run-app-anonymous expected=403 observed=403 result=PASS
probe=run-app-junk-bearer expected=401 observed=401 result=PASS
summary=all-refused
```

### wif (stand-in STS)

```text
# deny-proof probe record (redacted)
mode=wif
time_utc=2026-10-17T21:22:00Z
commit=unknown
pipeline=local
probe=wif-exchange-on-oidc-probe-context expected=denied observed=denied result=PASS detail=http=403 error="unauthorized_client: The given credential is rejected by the attribute condition."
summary=all-refused
```

### context (real local run)

```text
# deny-proof probe record (redacted)
mode=context
time_utc=2026-10-17T21:22:00Z
commit=unknown
pipeline=local
probe=context-var-GOOGLE_PROJECT_ID expected=absent observed=absent result=PASS
probe=context-var-GOOGLE_PROJECT_NUMBER expected=absent observed=absent result=PASS
probe=context-var-DEPLOYER_SA expected=absent observed=absent result=PASS
probe=context-var-PUBLIC_BASE_URL expected=absent observed=absent result=PASS
probe=context-var-VERCEL_TOKEN expected=absent observed=absent result=PASS
probe=context-var-VERCEL_ORG_ID expected=absent observed=absent result=PASS
probe=context-var-VERCEL_PROJECT_ID expected=absent observed=absent result=PASS
summary=all-refused
```

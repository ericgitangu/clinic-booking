# ADR-0017: Security testing in the pipeline

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted (the ZAP job is third in the cut order). Amended 2026-10-16: Go gates for stretch S1.

**Build status (audit 2026-10-17): Mostly built.** SAST, SCA, secrets, container and IaC scans, schemathesis and a ZAP API scan run in CI. ZAP runs on pull requests only, not on the release workflow. Pending: the Go scanners (S1).

## Context

We want one non-redundant tool per concern. Each one should be a real gate, not theatre. Nothing may fuzz the production database.

## Considered options

1. A ZAP baseline after promote, against prod `/docs`.
2. ZAP API scan against an ephemeral compose stack, before deploy.
3. No DAST.

## Decision

Option 2, alongside the static gates below.

| Concern | Tool (version pinned in the CI config) | Where | Gate |
|---|---|---|---|
| Python SAST | ruff `S` rules (standalone bandit dropped as a duplicate) | pre-commit + CI | any finding |
| Polyglot SAST | semgrep 1.181.0 `--config p/python --config p/typescript --config p/owasp-top-ten --error --metrics=off` (no `SEMGREP_APP_TOKEN`, never `semgrep ci`; a ruleset that demands login is replaced by a vendored local copy; $0 audit) | CI | error |
| Python SCA | pip-audit 2.10.1 on `uv export --frozen --no-dev --format requirements-txt` | CI | any vuln (dated ignore with justification allowed) |
| JS SCA | `pnpm audit --prod --audit-level high` | CI (when web exists) | high+ |
| Secrets | gitleaks (`git --pre-commit --staged` locally; full history in CI) | both | any |
| Container + IaC | trivy `image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`; `trivy config infra backend/Dockerfile` | CI, before push | high+ |
| API fuzz / contract | schemathesis 4.31.1, in-process | CI | any failure |
| DAST | `zap-api-scan.py -t http://api:8080/openapi.json -f openapi -c rules.tsv` against docker compose on a machine executor | PR and release, before deploy | exit 0/2 pass; 1/3 fail |
| Go SCA (stretch S1) | `govulncheck ./...` in `services/realtime` (reachability-aware) | CI | any reachable vuln |
| Go SAST (stretch S1) | `gosec ./...` in `services/realtime` | CI | any issue (inline `#nosec` only with a reason) |
| Go image (stretch S1) | trivy `image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` on the distroless realtime image | CI, before push | high+ |

**Base-image CVE runbook.** Rebuild on the newest `python:3.12-slim` digest. If the CVE is still unfixed, add a dated `.trivyignore` entry with a justification. The base digest is frozen at feature freeze.

## Consequences

- Good: the active scan runs against throwaway data and can actually block a deploy.
- Bad: the machine executor costs more credits. It is the only job that uses one.
- Rejected: any scan of prod. gosec and govulncheck were rejected while there was no Go; they are adopted with stretch S1 and exist only if S1 ships.
- The ZAP scan targets the API's OpenAPI document only; the SSE gateway is covered by its unit and integration tests and the post-deploy stream smoke, not by DAST.

## Assessment line

Section 3: "what the pipeline does".

## Review trigger

Handling real PII. That means an authenticated API scan against a preview environment.

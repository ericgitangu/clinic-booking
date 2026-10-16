# Runbook: base-image CVE

When `trivy image` fails the `build-scan` job on a HIGH/CRITICAL in the base image
(`python:3.12-slim`), not in our own dependencies:

1. **Rebuild on the newest digest.** Re-resolve the current `python:3.12-slim` digest:
   ```bash
   docker buildx imagetools inspect python:3.12-slim | rg '^Digest:'
   ```
   Update the two `FROM python:3.12-slim@sha256:...` lines in `backend/Dockerfile` and record
   the new digest and date in the Dockerfile comment. Rebuild and re-scan.
2. **If still unfixed upstream.** Add a dated, justified entry to `.trivyignore`:
   ```
   CVE-XXXX-YYYY # no fix in debian bookworm yet; not reachable from our code path; expires 2026-11-15
   ```
   The entry must name why it is not exploitable here and an expiry no more than 30 days out.
3. **Review at expiry.** When the expiry passes, remove the entry and re-scan; the CVE must
   be fixed upstream or re-justified.
4. **Feature freeze.** At feature freeze (Wed 21 Oct 20:00 EAT) the base digest is frozen;
   after that, only a release-blocking CVE justifies a new base image.

Cost note: scanning stays in CI (Trivy). The GCP Artifact Analysis / container-scanning APIs
stay disabled (ADR-0016, ADR-0014).

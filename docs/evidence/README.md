# Evidence

Recorded observations that back a claim the code cannot prove by itself. One file per claim or
dated observation. Each file says who or what observed it, when, and whether it is a real
production observation, a local dry run against a stand-in, or a template waiting for the first
real run. Never present one as the other.

## Files

| File | Backs | Source |
|---|---|---|
| `spend-cap-2026-10-18.md` | ADR-0014 spend cap is configured (read by `cost_check.sh` C11) | console observation |
| `iam-deny-proof.md` | ADR-0016 "saved WIF-deny and context-deny logs", ADR-0023 no public Cloud Run | CircleCI artifacts of `deny_probe.sh` |

## Redaction rules

- No tokens, keys, passwords, cookies, signed URLs or OIDC/ID tokens, ever.
- No account ids beyond what the repository already publishes (the project id, and the project
  number in `infra/terraform/terraform.tfvars.example`). No billing account id, no other
  projects or budgets on the shared billing account, no e-mail addresses.
- Opaque strings of 24 or more characters and numbers of 10 or more digits in tool responses are
  replaced with `[redacted]` by `scripts/ci/deny_probe.sh` before anything is written.
- A pasted CircleCI log or console text is reduced to the fields in the record format; it is not
  pasted whole.

## Probe record format

`scripts/ci/deny_probe.sh <run-app|wif|context> <file>` writes `key=value` lines:

```text
# deny-proof probe record (redacted)
mode=<run-app|wif|context>
time_utc=<UTC time>
commit=<git sha or unknown>
pipeline=<CircleCI build URL or local>
probe=<name> expected=<value> observed=<value> result=<PASS|FAIL> [detail=...]
summary=<all-refused|N-not-refused>
```

CircleCI keeps the raw record as an artifact under `evidence/` for the job that produced it
(`smoke-public` for `run-app`, `wif-deny-probe` for `wif` and `context`). To turn a run into a
committed entry, copy the lines of the artifact into the matching section of
`iam-deny-proof.md`, replace the template marker, and keep the build URL in `pipeline=`.

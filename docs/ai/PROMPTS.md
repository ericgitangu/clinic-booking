# AI prompt log

Engineer-maintained. Each entry records a prompt that materially shaped the work, so the
README §11 reflection can cite it by id. Do not fabricate entries; add one only for a prompt
that actually ran.

## Entry template

```
### <id, e.g. P-001>  <YYYY-MM-DD>
- WP: <work package>
- Context: <what was being worked on>
- Prompt: <verbatim prompt>
- Outcome: <what changed; commit SHA>
- Verdict: <helped | wrong/incomplete and how caught>
```

## How AI was used (process)

- One planning/gatekeeper session (Opus) did design, red-team and verification. One build session (Sonnet, medium effort) implemented the work packages. Multi-agent review runs (Sonnet) audited each milestone. Haiku was used only for mechanical edits.
- Every AI claim had to be backed by an observed result (a test run, a live HTTP response or a live `gcloud` read) before it was accepted. Self-reported passes were re-run by the gatekeeper.
- Every change lands through a PR. The PR is red-teamed and signed off before merge, and CircleCI runs the test suite on every PR.
- Exported session transcripts are the primary record. Each entry below quotes the prompt that actually ran: verbatim where it is short, an excerpt where it is long.

### P-001  2026-10-16
- WP: planning
- Context: kickoff, with the assessment PDF attached.
- Prompt (excerpt): "every extra must be justifiable ... the reasoning is the glue ... draft a well curated end-to-end ADR that we can delegate to lower order models to execute to the tee"
- Outcome: research, three independent designs, a synthesis and two red-team critiques produced 20 ADRs and PLAN.md (e3ed568).
- Verdict: helped. The red-team pass caught three deploy blockers in the AI's own draft. CircleCI's OIDC `sub` exceeds the 127-byte `google.subject` limit; the audience mapping was wrong; `--no-traffic` is rejected on a service that does not exist yet. It also found that the draft's "race control" test proved nothing: sequential requests also duplicate once the index is dropped.

### P-002  2026-10-16
- WP: planning
- Context: the red-team proposed cutting the realtime, OAuth and dashboard extras.
- Prompt: "Keep the lean core as written. Add a gated stretch tier that starts only after Gate B passes: 1) Go SSE gateway feeding a live recharts admin dashboard, 2) PWA plus dark/light theme, 3) OAuth for admin only, 4) Turnstile/reCAPTCHA."
- Outcome: stretch tier S1-S4, gated on prod smoke passing (ADR-0021, ADR-0022).
- Verdict: an engineer decision overriding AI advice. It is recorded here because the AI recommended a narrower scope.

### P-003  2026-10-16
- WP: planning ($0 audit)
- Prompt: "Clarification this is an interview - 0 cost is a prime directive!"
- Outcome: the audit, run against official pricing pages, showed Cloud Run's free egress covers North America to North America only. The AI's earlier europe-west3 plan would therefore bill every byte served to Kenya. The fix was Cloud Run in us-east4, IAM-only, with a Vercel proxy (ADR-0023, PLAN §13).
- Verdict: AI output was wrong and an audit caught it. The first plan's "$0" claim for europe-west3 did not survive the official pricing docs.

### P-004  2026-10-16
- WP: planning
- Prompt: "Vercel for frontend and GCP for the backend"
- Outcome: the hosting split was locked. The AI had recommended putting everything on Vercel; the engineer kept GCP for the backend.
- Verdict: an engineer decision made without AI.

### P-005  2026-10-16
- WP: process
- Prompt: "recall once we have the right ADRs we will delegate these to a more cost/token-efficient model - for implementation!"
- Outcome: the AI had started implementation before the ADRs were locked. The engineer stopped it, the partial output was discarded, and implementation restarted after lock-in.
- Verdict: an AI process error, caught by the engineer.

### P-006  2026-10-16
- WP: lean core, Gate 1
- Context: the build passed 86 tests, and the gate audit forced a real deadlock through PATCH /reschedule.
- Outcome: the deadlock retry and the 409 CONCURRENT_UPDATE path never ran. asyncpg raises 40P01 as `DBAPIError`, while the code caught `OperationalError`. The observed result was one 200 and one 500. The fix, with a forced-deadlock test, landed in 0477573.
- Verdict: AI-written code was wrong and green tests hid it. It was caught by an adversarial audit that exercised the real failure path.

### P-007  2026-10-16
- WP: cloud, Gate 2
- Outcome: 21 confirmed findings before any cloud resource existed. Examples: the bootstrap ran `gcloud run deploy` before enabling the Run API; a quoted array in a heredoc made the printed IAM commands un-pasteable; the deployer service account lacked permission to prune images; the $3 spend cap existed only as an echo.
- Verdict: helped. Each finding was confirmed by a second agent trying to refute it.

### P-008  2026-10-16
- WP: cloud bootstrap
- Outcome: project creation hit the developer account's project quota. The engineer freed a slot on a second account and chose the shared billing account after a dedicated one could not be reopened. §13 was recounted for the shared free tier.
- Verdict: engineer decisions. The AI surfaced the cost implication; the engineer made the call.

### P-009  2026-10-16
- WP: process
- Prompt: "push as PRs with terse comments of works then merge with red teams reporting and signing off on each PR when merging to main"
- Outcome: the branch, PR, red-team, sign-off and merge flow applies from this point onward.
- Verdict: an engineer process decision.

### Notes
- The engineer's pre-kickoff research (two Google AI Mode threads on "tRPC, gRPC and TanStack") could not be read by the tooling because of a CAPTCHA. The tRPC/gRPC verdict in ADR-0007 was re-derived from official sources.
- A small AI error: the build-session brief misspelled the repository name. The gatekeeper caught it before any push.
- README §11 (the Section 4 answers) is written by the engineer, citing these ids.

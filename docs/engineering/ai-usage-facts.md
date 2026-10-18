# AI usage: the facts

A factual appendix. It lists what agents did, what I decided, and where each fact comes from, so that README section 11 can be written from records and not from memory. Section 11 itself is separate and is mine. Items marked "not recorded" are things the repository does not hold.

## What I decided

Product, cost and security calls that were mine. The first column is where it is written down.

| Decision | Date | Source |
|---|---|---|
| Total cost is $0, provable from official free-tier pages ("0 cost is a prime directive") | 2026-10-16 | Project memory note; [ADR-0014](../adr/0014-hosting-region-and-cost.md) |
| Hosting split: Vercel front end, Cloud Run `us-east4` IAM-only, Neon `aws-us-east-1` | 2026-10-16 | [ADR-0023](../adr/0023-zero-cost-edge-front-door.md) (decided by the engineer) |
| Accept about $0.28 a month on the shared billing account, now stated as about $0.34 a month, and disclose it | 2026-10-16 | Memory note; README section 10 |
| ADRs are finished before any implementation starts; implementation then goes to cheaper models | 2026-10-16 | Memory note (stated twice) |
| Cut the optional stretch items for admin OAuth and the Turnstile bot check, later reinstated as Google sign-in and reCAPTCHA | 2026-10-16, 2026-10-17 | [ADR-0022](../adr/0022-admin-auth-and-bot-protection.md) |
| Drop the Docker Hub context and pull CI images through `mirror.gcr.io` | 2026-10-16 | [ADR-0016](../adr/0016-cicd-circleci-keyless-deploy.md) |
| Full production frontend in scope; Google sign-in, Resend email, branding | 2026-10-17 | ADRs 0024, 0025, 0026 (decided by the engineer); the scope amendment to ADR-0010 is dated 2026-10-17 in its header, whose Deciders line says only "engineering" |
| Two apps in one workspace, with the public hostnames | 2026-10-17 | ADRs 0027, 0028 |
| The booking flow and its one human check per action; staff roles by email | 2026-10-17 | ADRs 0029, 0030 |
| No mocks of our own code: "mocks are implementation gaps in disguise"; only third parties may be stood in, and labelled | 2026-10-17 | Memory note; [ADR-0018](../adr/0018-testing-strategy.md) |
| Frontend schemas are generated from the contract, not hand-written | 2026-10-17 | Message relayed to the build lane; [ADR-0011](../adr/0011-openapi-codegen-contract.md); PR 23 |
| Full CI-equivalent suite green locally before every push, one push per fix round | 2026-10-17 | Memory note |
| Ably's free package instead of SSE for both feeds, after a four-part review of cost, abuse, React and push transport; Go gateway PR closed | 2026-10-18 | PR 37 closing comment |
| The public REST API stays unauthenticated | 2026-10-17 | PR 20 ruling; [ADR-0012](../adr/0012-identity-and-abuse-controls-deferred.md) |
| Section 11 (AI reflection) is written by me only | 2026-10-16 | [ADR-0020](../adr/0020-git-hygiene-and-ai-disclosure.md) |

## What agents did

- **Planning and ADRs.** A planning session drafted the ADRs and the delivery plan. The ADR headers that say only "engineering" record that an agent proposed the text and I accepted it. Those with "decided by the engineer" record my decision.
- **Implementation lanes.** Each work package ran as a lane in its own git worktree and branch, from `main`, with its own compose project and ports, and opened its own pull request. Lanes did not merge.
- **Review.** A separate red-team review read each diff and ran its own checks. Its findings and the fixes are in [`verification.md`](verification.md).
- **Recorded without my decision table.** The gatekeeper session, not me, decided to declare the fresh-database limit and descope local test isolation, and to send email from the verified subdomain (ADR-0025 amendment in PR 27, open); I add the per-project Vercel admin token to CircleCI myself.
- **Merging.** A gatekeeper session merged pull requests, never the lane that built them, and only after the checks were green and the base branch was `main`.
- **Not done by agents.** Secrets were never handled by an agent: I created the reCAPTCHA and OAuth credentials myself, and the Vercel and CircleCI tokens were passed straight into their contexts without being printed. Cloud steps that create or change a resource (`gcloud`, `neonctl`, `vercel`, `circleci`) waited for my approval, until I authorised the bootstrap runbook steps 1 to 9 within the $0 guards on 2026-10-16.

## Model routing

From my routing rules and the lane records:

- Planning, ADRs and architecture: the largest model tier (opus in my routing table).
- Build lanes: Sonnet at medium effort.
- Red-team review: Sonnet at high effort.
- Mechanical bulk edits (config, autofix): Haiku.
- No multi-agent fan-out inside a lane, and review reports bounded to about 15 lines.

This lane (documentation) ran on Sonnet.

## Stop rules and gates

- **The $0 rule.** Halt if the shared billing account stops being $0 on compute, or anything billable appears. The recorded outcome is not $0 on the shared account: Artifact Registry and Secret Manager are over their free tiers there.
- **Usage stop.** Autopilot stops at 68 percent of weekly usage. On 2026-10-18 the gatekeeper paused all lanes at 71 percent, and I then told it in chat to resume with every gate kept. Weekly usage resets 2026-10-19 05:00 UTC.
- **Spend cap.** A $3 Cloud Run spend cap, managed in the cloud console. `docs/evidence/spend-cap-2026-10-18.md` records the console observation (status Configured, created in the console after the Terraform version proved to be alerts-only); `scripts/cost_check.sh` checks that the budgets exist.
- **Never touch** my other GCP projects; no `terraform apply`, no cloud mutation from a documentation or test lane.
- **Commits.** Terse, human, no tooling references, no trailers ([ADR-0020](../adr/0020-git-hygiene-and-ai-disclosure.md)). A pre-commit hook enforces lint, a commit-message hook enforces length, and gitleaks runs on staged files.
- **Merge gate.** Verify every check green as its own step; verify `baseRefName == main` (PR 24 once merged into a feature branch).

## Human checkpoints

1. ADRs reviewed and locked before the build started.
2. Each cloud step approved, then the runbook authorised within the $0 guards.
3. Billing account choice and the option A cost acceptance.
4. Credentials created by me: reCAPTCHA keys, the Google OAuth client, tokens, DNS records at the registrar.
5. Every pull request red-teamed before merge.
6. A read-through of the finished repository and the live site before submission, with a written checklist that is not part of the repository.

## Not recorded

- The share of code generated by agents compared with written by hand, per package. Section 11 asks for it, and the repository has no measure.
- The raw prompt log. It is kept out of git on purpose ([ADR-0020](../adr/0020-git-hygiene-and-ai-disclosure.md)), so the quotations for section 11 come from my exported session transcripts.

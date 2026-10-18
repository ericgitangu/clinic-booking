# ADR-0020: Git hygiene and AI-usage disclosure

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted

**Build status (2026-10-18, main a2d1117): Partly shipped.** Commits carry no tooling trailers. README section 11 and the `v1.0.0` tag are the engineer's and are tracked outside this ADR.

## Context

The brief's Section 4 asks how AI was used and says "honesty matters more than the answer". We also want a clean history and a clean tree: no tooling trailers in commits, and no local tooling files in the repository.

## Considered options

1. Disclose AI use through commit trailers.
2. Disclose in one place, README section 11 backed by a prompt log, and keep commits trailer-free.

## Decision

Option 2.

- **Commits:** Conventional Commits, one PR per work package, squash-merge, PR title = commit subject. No trailers of any kind.
- **Local files:** local tooling directories and personal instruction files are listed in `.git/info/exclude`, which is local and uncommitted. The committed `.gitignore` carries no tooling-specific entries.
- **Release:** tag `v1.0.0` at submission, and record the SHA in the README.
- **Disclosure:** README section 11 (AI usage is summarized there; the raw prompt log is kept out of git).
  - Prompts come from **exported session transcripts**, not from memory.
  - Each entry records the date, the prompt verbatim, what was accepted, rejected or corrected, and the commit SHA.
  - Section 11 includes a per-work-package table of how much code was agent-generated versus hand-written.
- **The two "decisions made without AI"** must be decisions that predate or override AI output, each citing the message or commit where it was made. "AI was wrong" examples must cite their source in the log.
- **Ownership:** Section 11 is written by the engineer only. Executors leave marked slots.

## Consequences

- Good: the disclosure is complete, and it lives where reviewers will read it.
- Bad: keeping the log up to date during the work is a discipline cost.

## Assessment line

Section 4: "Honesty matters more than the answer."

## Review trigger

None.

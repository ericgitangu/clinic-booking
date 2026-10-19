.DEFAULT_GOAL := help
SHELL := /bin/bash
BE := cd backend && uv run

# Host port for the compose Postgres. The tests connect to the same port, so the pair stays in
# sync; if 5432 is taken, run e.g. `DB_HOST_PORT=5433 make up test`.
DB_HOST_PORT ?= 5432
export DB_HOST_PORT
export TEST_DB_PORT ?= $(DB_HOST_PORT)

.PHONY: help up down logs migrate seed test test-unit test-int test-race test-control \
        contract lint lint-go fmt typecheck audit sec openapi gen-client verify migration-lint hygiene cost-static cost-check cost-selftest ci-test shared-headroom env-pull e2e e2e-admin avatars \
        api-collection api-check api-check-prod

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

up: ## Build and start the stack, wait for health
	docker compose up -d --build --wait

down: ## Stop the stack and remove volumes
	docker compose down -v

logs: ## Follow logs
	docker compose logs -f

migrate: ## Run migrations (one-shot)
	docker compose run --rm --build migrate

seed: ## Run the seed against the running stack
	docker compose exec -T api python -m app.scripts.seed

lint: ## markdown, TypeScript, Python (ruff + mypy --strict), zero warnings (husky and the CI lint job call this)
	pnpm exec markdownlint-cli2
	pnpm -r --if-present lint
	pnpm -r --if-present typecheck
	($(BE) ruff check .) && ($(BE) ruff format --check .)
	$(BE) mypy --strict app tests migrations
	@echo "lint: Go checks are not part of this target; they run in 'make lint-go' (the go-quality CI job and the pre-push hook)"

# Split from `lint` because the CI lint image has no Go toolchain; go-quality (Go image) calls this.
lint-go: ## Go: gofmt, go vet, staticcheck, golangci-lint (pinned, strict); go-quality and husky call this
	$(MAKE) -C services/realtime vet staticcheck lint

hygiene: ## Repo hygiene: tracked junk, untracked files, AI-code smells
	bash scripts/repo_hygiene.sh

fmt: ## ruff format + autofix
	$(BE) ruff format . && $(BE) ruff check --fix .

typecheck: ## mypy --strict
	$(BE) mypy --strict app tests migrations

test: ## Full test suite
	$(BE) pytest

test-unit: ## Unit tests
	$(BE) pytest tests/unit

test-int: ## Integration tests
	$(BE) pytest tests/integration

test-race: ## Concurrency race tests
	$(BE) pytest -m race -rA

test-control: ## Naive-control concurrency tests
	$(BE) pytest -m control -rA

contract: ## Schemathesis contract tests
	$(BE) pytest tests/contract

audit: ## pip-audit over the locked deps
	$(BE) pip-audit

sec: ## Local security checks (SAST/DAST run in CI)
	$(BE) pip-audit

openapi: ## Export the OpenAPI contract
	$(BE) python -m scripts.export_openapi

gen-client: ## Regenerate the TS types, zod schemas, SDK and the public spec snapshot from contracts/openapi.json
	pnpm -C packages/api gen
	pnpm -C apps/booking snapshot

verify: ## Verify live claims (URL=...)
	uv run --project backend python scripts/verify_claims.py --base-url "$(URL)"


migration-lint: ## Enforce expand-only migrations
	bash scripts/migration_lint.sh

cost-static: ## $0 static guards (no credentials)
	bash scripts/cost_check.sh --static

cost-check: ## $0 live guards, read-only (PROJECT=...)
	bash scripts/cost_check.sh --live

shared-headroom: ## Read-only 30-day usage of the other projects on the shared billing account (PROJECTS='project:account ...')
	python3 scripts/shared_headroom.py $(PROJECTS)

cost-selftest: ## Prove the cost guard by mutation (no cloud)
	bash scripts/cost_check_selftest.sh

avatars: ## Regenerate the AI doctor portraits (needs a cached Hugging Face login; calls a third-party Space) and sync them
	uv run --with gradio_client --with huggingface_hub python scripts/avatars/portraits.py
	node scripts/avatars/sync.mjs

ci-test: ## Test the CI helper scripts against fakes (no cloud)
	bash scripts/ci/test_ci_scripts.sh

env-pull: ## Fill apps/booking/.env.local (gitignored) from Vercel's Development environment; sensitive values are not returned
	cd apps/booking && vercel env pull .env.local --environment=development
	@printf '%s\n' \
	  'NOTE: Vercel never returns variables marked Sensitive through env pull.' \
	  'Copy those into apps/booking/.env.local by hand: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BETTER_AUTH_SECRET,' \
	  'INTERNAL_SIGNING_KEY, RESEND_API_KEY, CRON_SECRET and the API/proxy variables. The example file marks them' \
	  '"sensitive: copy manually". Local sign-in uses the http://localhost:3000/auth/callback/google redirect.'

e2e: ## Playwright checks against the real API and database (their own docker compose project, migrations and seed) and a production build
	# Its own compose project, ports and keys, and a fresh database every time, so it never touches (or
	# `down -v`s) a developer's running stack, and the scenarios always start from an empty database.
	# The API verifies signed assertions with INTERNAL_SIGNING_KEY, the app signs sessions with
	# BETTER_AUTH_SECRET, and the reminder route wants CRON_SECRET: throwaway values for this run. The
	# email allowances are raised so the day's counter never limits a run: every booking sends an email,
	# and the cap itself is exercised by its own scenario (e2e/emails-cap.spec.ts) and the backend tests.
	export COMPOSE_PROJECT_NAME=clinic-e2e API_HOST_PORT=18080 DB_HOST_PORT=15432 \
	  E2E_API_URL=http://127.0.0.1:18080 REAL_API_URL=http://127.0.0.1:18080 \
	  WEB_ORIGIN=http://localhost:3100 INTERNAL_SIGNING_KEY=$$(openssl rand -hex 32) BETTER_AUTH_SECRET=$$(openssl rand -hex 32) CRON_SECRET=$$(openssl rand -hex 32) \
	  EMAIL_DAILY_LIMIT=100000 EMAIL_MONTHLY_LIMIT=1000000 EMAIL_ACK_RESERVE=0; \
	docker compose -p clinic-e2e down -v && docker compose -p clinic-e2e up -d --build --wait && \
	pnpm -C packages/api exec vitest run tests/real-api.test.ts && \
	pnpm -C apps/booking exec vitest run tests/two-instances.test.ts tests/email-allowance.test.ts && \
	cd apps/booking && pnpm build && pnpm test:e2e

api-collection: ## Rebuild the reviewer collection in docs/api/ from contracts/openapi.json
	node scripts/api_collection.mjs

api-check: ## Run the reviewer collection with newman against its own compose stack (Docker only)
	bash scripts/api_check.sh local

api-check-prod: ## The collection's read-only requests against production; API_WRITES=1 adds the booking writes
	bash scripts/api_check.sh production

e2e-admin: ## Playwright for apps/admin against the real build, API and Postgres (compose); only Google sign-in is replaced
	bash scripts/e2e_admin.sh

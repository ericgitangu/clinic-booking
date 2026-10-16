.DEFAULT_GOAL := help
SHELL := /bin/bash
BE := cd backend && uv run

# Host port for the compose Postgres. The tests connect to the same port, so the pair stays in
# sync; if 5432 is taken, run e.g. `DB_HOST_PORT=5433 make up test`.
DB_HOST_PORT ?= 5432
export DB_HOST_PORT
export TEST_DB_PORT ?= $(DB_HOST_PORT)

.PHONY: help up down logs migrate seed test test-unit test-int test-race test-control \
        contract lint fmt typecheck audit sec openapi gen-client verify docs-check migration-lint cost-static cost-check

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

up: ## Build and start the stack, wait for health
	docker compose up -d --build --wait

down: ## Stop the stack and remove volumes
	docker compose down -v

logs: ## Follow logs
	docker compose logs -f

migrate: ## Run migrations (one-shot)
	docker compose run --rm migrate

seed: ## Run the seed against the running stack
	docker compose exec -T api python -m app.scripts.seed

lint: ## ruff check + format check
	$(BE) ruff check . && $(BE) ruff format --check .

fmt: ## ruff format + autofix
	$(BE) ruff format . && $(BE) ruff check --fix .

typecheck: ## mypy --strict
	$(BE) mypy app

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

gen-client: ## Regenerate the TS client (web)
	pnpm -C web gen:api

verify: ## Verify live claims (URL=...)
	uv run --project backend python scripts/verify_claims.py --base-url "$(URL)"

docs-check: ## Check docs links and ADR headings
	python scripts/docs_check.py

migration-lint: ## Enforce expand-only migrations
	bash scripts/migration_lint.sh

cost-static: ## $0 static guards (no credentials)
	bash scripts/cost_check.sh --static

cost-check: ## $0 live guards, read-only (PROJECT=...)
	bash scripts/cost_check.sh --live

# Targets for the Go realtime gateway. Run from this directory or with `make -C services/realtime`.
# The integration tests need the compose stack from the repository root (`make up`, which also
# creates the clinic_realtime login and runs migration 0014); they use the real database and API and fail loudly if either is missing.
# A stream sees every event in the database, so run one test process at a time against a given stack (two at once see each
# other's bookings).
SHELL := /bin/bash

# Host ports of the compose stack under test (override when 5432 / 8080 are taken).
DB_HOST_PORT  ?= 5432
API_HOST_PORT ?= 8080

export TEST_OWNER_DSN    ?= postgres://clinic:clinic@127.0.0.1:$(DB_HOST_PORT)/clinic
export TEST_REALTIME_DSN ?= postgres://clinic_realtime:clinic_realtime_local@127.0.0.1:$(DB_HOST_PORT)/clinic
export TEST_API_URL      ?= http://127.0.0.1:$(API_HOST_PORT)

# Pinned tool versions (docs/adr/0017), run with `go run` so nothing is installed globally.
GOLANGCI_LINT := github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
STATICCHECK   := honnef.co/go/tools/cmd/staticcheck@v0.8.2
GOVULNCHECK   := golang.org/x/vuln/cmd/govulncheck@v1.9.0
GOSEC         := github.com/securego/gosec/v2/cmd/gosec@v2.29.0

.PHONY: test unit vet lint staticcheck vuln sec check image

test: ## Race-enabled tests against the compose stack
	go test -race -count=1 ./...

unit: ## Tests that need no stack (assertion vectors, cursor, config, shared event examples)
	go test -race -count=1 ./internal/assertion ./internal/cursor ./internal/config ./internal/events

vet: ## gofmt and go vet
	test -z "$$(gofmt -l .)"
	go vet ./...

lint: ## golangci-lint with the repository's strict .golangci.yml
	go run $(GOLANGCI_LINT) run --config ../../.golangci.yml ./...

staticcheck: ## staticcheck
	go run $(STATICCHECK) ./...

vuln: ## govulncheck (reachability-aware)
	go run $(GOVULNCHECK) ./...

sec: ## gosec, any issue fails
	go run $(GOSEC) -quiet ./...

check: vet staticcheck lint test vuln sec ## Everything CI runs for this module

image: ## Build the distroless image and print its size
	docker build --provenance=false --sbom=false --load -t clinic-realtime:local .
	docker image inspect --format '{{.Size}} bytes' clinic-realtime:local

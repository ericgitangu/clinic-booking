# ADR-0019: Observability

- Date: 2026-10-16
- Deciders: engineering

## Status
Accepted

## Context
Errors carry a `request_id`, and that id should lead straight to a log line. Logs must never contain PII: names, phones, emails, cancellation reasons, or SQL bound parameters.

## Considered options
1. stdlib logging with a JSON formatter, request ids and `Server-Timing`.
2. The OpenTelemetry SDK exporting to Cloud Trace.
3. Sentry.

## Decision
Option 1.
- **Logs:** one JSON object per line on stdout, with `severity, message, request_id, method, route, status, latency_ms, code`, plus `logging.googleapis.com/trace` taken from `X-Cloud-Trace-Context`.
- **Request IDs:** an inbound `X-Request-ID` is accepted only if it is a UUID; otherwise one is generated. It is echoed in the response header and in every problem body.
- **Timing:** `Server-Timing: db;dur=X, app;dur=Y`.
- **Middleware:** pure ASGI. No `BaseHTTPMiddleware`, no GZip.
- **PII:**
  - The engine uses `hide_parameters=True`, so SQLAlchemy exception strings never carry bound values.
  - A redaction unit test covers the formatter.
  - An integration test forces a CHECK violation and asserts that neither the reason nor the patient id reaches the logs.
- **Health:** `/healthz` is liveness and never touches the DB, so it never wakes Neon. `/readyz` runs `SELECT 1`.

## Consequences
- Good: zero cost, and Cloud Logging correlates by trace.
- Bad: no distributed traces or metrics dashboards (TD11).
- Stretch S1 adds a second service, which meets this ADR's review trigger. We still decline OTel for it: the gateway is read-only and never calls the API, so there is no cross-service request to trace. It logs JSON with the same field names via `log/slog`, and each event's `<txid>.<id>` ties a stream frame to its row. If the services ever call each other, the trigger applies in full.

## Assessment line
"Meaningful errors": `request_id` ties a problem body to its log line.

## Review trigger
A second service or an async worker. That means OTel to Cloud Trace.

# Event contract v1

What the API pushes to browsers over the push service's SSE endpoint. The JSON Schemas here are
exported from `backend/app/schemas/events.py` by `make openapi`; the same models are in
`contracts/openapi.json` (components `SlotEvent`, `AdminEvent`), so `make gen-client` produces their
types and zod schemas. Nothing the push service carries names a person or an appointment; the
staff shapes further down do, and only the Go gateway sends them.

| Channel | Message | Schema |
|---|---|---|
| `slots:{doctor_id}:{local_date}` | `slot_taken`, `slot_freed` | `slot-event.v1.schema.json` |
| `admin:events` | `booked`, `rescheduled`, `cancelled` | `admin-event.v1.schema.json` |

The admin channel also carries the staff annotations `vetoed`, `unlocked`, `arrived` and `no_show`
in the same `AdminEvent` shape.

The Go gateway (`services/realtime`, ADR-0021) streams the admin feed to the admin app over its own
IAM-protected SSE stream, never through the push service. A viewer gets the shapes on the left, an
owner or admin the ones on the right:

| Source | Events | Viewer | Owner, admin |
|---|---|---|---|
| `appointment_events` | the seven event types above | `admin-event.v1.schema.json` | `staff-event.v1.schema.json` (adds the appointment, patient, cancellation reason and, for a staff change, `actor_email`, `actor_role`, `staff_reason`) |
| `staff_action_audit` | `reminder_now`, `running_late`, `invite_created`, `invite_revoked`, `invite_accepted` | `admin-action.v1.schema.json` | `staff-action.v1.schema.json` (adds who, why, the patient and the invited address) |

Both sources share one cursor, `<txid>.<id>` (migration 0014). `examples.v1.json` and
`action-examples.v1.json` pin the Python models and the Go encoder to the same messages.

A reschedule is a `slot_freed` (old time, old day's channel) plus a `slot_taken` (new time).
`starts_at` is a UTC instant: compare instants, not strings, with the offset-bearing times of the
availability response.

## Ordering and duplicates

Every outbox event has a cursor `"<txid>.<id>"`: the transaction that wrote it and its row id, both
integers (compare them as `BigInt` pairs, txid first). A patient message's `seq` is the cursor plus
`.0` (the freed half) or `.1` (the taken half), so the two messages of one event still order.

- The availability response carries `cursor`: every event whose `(txid, id)` sorts at or before it is
  already reflected in `slots`. Accept a polled response only if its cursor is not older than the one
  you hold.
- Apply a pushed message only if its `seq` sorts after the last one you applied **and** its
  `(txid, id)` sorts after the cursor of the availability response you are showing. Delivery is at
  least once and not guaranteed to be in order after a reconnect, so a repeat is dropped by `seq`.
- After every (re)connect do one refetch of the availability: the push service documents no
  signal for a failed resume on SSE.

## What the service really does (observed against the live service in CI)

- A JWT works as a raw `Authorization: Bearer <jwt>` value on the event-stream endpoint (no extra
  base64, no `accessToken` in the URL).
- A refused or expired token does **not** produce an HTTP error status. The stream opens with `200`
  and its first frame is `event: error` with data such as
  `{"message":"token expired","code":40142,"statusCode":401}`. A client must read error frames:
  codes 40140 to 40149 mean "mint a new token"; 40160 means the token may not read this channel
  (do not retry; poll); anything else is a service problem (back off and poll).

## Credentials

`POST /realtime/token/patient` (body `{doctor_id, date}`, public, rate limited) and
`POST /internal/realtime/token/admin` (owner or admin assertion) return a five-minute, subscribe-only
JWT for exactly one channel and a `stream_url`. Open the stream with
`Authorization: Bearer <token>`; the connection ends when the token expires, so close it and mint a
new token (the native `EventSource` cannot do either). A `503 REALTIME_UNAVAILABLE` means push is off
(not configured, or the month's publish budget is spent): poll. A `429 RATE_LIMITED` carries
`Retry-After`.

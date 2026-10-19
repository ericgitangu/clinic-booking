# API collection

A Postman v2.1 collection of the reviewer journey through the booking API, with two environments. The files are built from [`contracts/openapi.json`](../../contracts/openapi.json) by [`scripts/api_collection.mjs`](../../scripts/api_collection.mjs) (`make api-collection`); edit the script, not the JSON. CI fails when the committed files differ from a fresh build, and the build fails when a public operation in the contract is not in the journey.

| File | What it is |
|---|---|
| `clinic-booking.postman_collection.json` | The requests, their pre-request scripts and their tests |
| `local.postman_environment.json` | `baseUrl` `http://localhost:8080` (the compose API), writes on |
| `production.postman_environment.json` | `baseUrl` `https://clinic.ericgitangu.com/api`, writes off |

Production goes through the booking site's `/api` proxy on Vercel because Cloud Run is IAM-only. None of the public endpoints needs a token, so neither environment holds a credential.

## Run it

```bash
make api-check
```

This needs Docker only. It brings up its own compose project (`clinic-apicheck`, API on host port 18180, so a running `make up` stack is left alone), runs every folder with newman from the published image (pinned by digest), and removes the stack. `KEEP_STACK=1 make api-check` leaves it running.

```bash
make api-check-prod
```

This runs only the GET requests against production. Every other request is skipped by its pre-request script while `allowWrites` is not `true`. `API_WRITES=1 make api-check-prod` turns the writes on: it creates two patients and one booking in the live database, then cancels the booking.

## The journey

| Folder | What it shows |
|---|---|
| 01 Health | `/health`, `/ready` and the error catalogue |
| 02 Doctors | The seeded doctors; the first is used from here on |
| 03 Slots | Free slots on the first day from tomorrow with at least two, moving a day ahead (up to 14 times) over weekends and full days |
| 04 Book with an Idempotency-Key | A booking, its replay (same id, `Idempotent-Replayed: true`), the same key with another time (`422 IDEMPOTENCY_KEY_REUSED`), and the patient's list holding one appointment |
| 05 Double booking | A second patient on the same slot: `409 SLOT_TAKEN` |
| 06 Too soon | A booking and a reschedule to 30 minutes from now: `422 BOOKING_TOO_SOON` |
| 07 Reschedule and cancel | Move (same id), repeat the move, cancel, cancel again (`409 APPOINTMENT_ALREADY_CANCELLED`), reuse the key (`409 IDEMPOTENCY_KEY_CONSUMED`) |
| 08 Change within the hour | Cancel and reschedule a visit starting in under an hour: `409 CHANGE_TOO_LATE` |
| 09 Validation errors | Bad UUID, missing fields, phone not E.164, bad `Idempotency-Key`, no UTC offset, past, off the grid, outside working hours, unknown doctor, beyond the horizon, short cancel reason, and 404s |

Every request asserts the status and the content type (`application/problem+json` for every error), checks the body against the response schema the contract declares (the Problem schema for errors), and checks the fields that matter for that step. IDs and times pass between requests in collection variables. Every time is computed from now in a pre-request script.

**Folder 08 needs a seeded appointment.** The API never books a slot less than an hour away, so no request can create the visit this folder changes. `make api-check` writes one straight into the local database and passes its id as `soonAppointmentId`; it also prints the id. In Postman, paste that id into the local environment's `soonAppointmentId`. When it is empty the two requests are skipped, and against production they always are.

## Postman and Insomnia

- **Postman** (desktop or web): Import, choose the three files, pick an environment, then run the collection or send requests one by one in folder order. Nothing needs an account beyond Postman's own sign-in, and no cloud workspace is used.
- **Insomnia**: Import the collection file; Insomnia reads the Postman v2.1 format. Set `baseUrl` (and `allowWrites`) in an Insomnia environment. Insomnia's support for Postman's `pm` script API is partial, so the tests may not all run there; newman and Postman are the checked paths. I have not run the Insomnia import myself, and `inso` cannot run a Postman file.
- **newman** without make: `newman run docs/api/clinic-booking.postman_collection.json -e docs/api/local.postman_environment.json` against a stack started with `make up`.

# API collection

A Postman v2.1 collection of the reviewer journey through the booking API, with two environments. The files are built from [`contracts/openapi.json`](../../contracts/openapi.json) by [`scripts/api_collection.mjs`](../../scripts/api_collection.mjs) (`make api-collection`); edit the script, not the JSON. CI fails when the committed files differ from a fresh build, and the build fails when a public operation in the contract is not in the journey. That check covers the contract to the collection only. Whether the contract matches the running API is the `backend-contract` job's check.

| File | What it is |
|---|---|
| `clinic-booking.postman_collection.json` | The requests, their pre-request scripts and their tests |
| `local.postman_environment.json` | `baseUrl` and `writeBaseUrl` both `http://localhost:8080`, the `make up` stack |
| `production.postman_environment.json` | `baseUrl` `https://clinic.ericgitangu.com/api`, and no `writeBaseUrl` |

Production goes through the booking site's `/api` proxy on Vercel because Cloud Run is IAM-only. None of the public endpoints needs a token, so neither environment holds a credential.

**Reads and writes.** GET requests go to `baseUrl`. Every other request goes to `writeBaseUrl`. The production environment does not define `writeBaseUrl`, so those requests have no host: the pre-request scripts skip them, and a client that ignores the scripts sends them nowhere. A newman run with every script removed showed this: each write failed with `getaddrinfo ENOTFOUND {{writebaseurl}}`. Writes still reach production if someone sets `writeBaseUrl` to the production base themselves. The public API is unauthenticated by design (README, section 4.2), so curl can do the same.

The lead time (60 minutes, `BOOKING_MIN_LEAD_MINUTES`) is read from the contract when the collection is built, so the "too soon" times and the test names follow the deployed value.

## Run it

```bash
make api-check
```

This needs Docker only. It brings up its own compose project (`clinic-apicheck`, API on host port 18180, so a running `make up` stack is left alone), runs every folder with newman, and removes the stack. newman runs from `postman/newman:6.1.3-alpine` pinned by digest (`sha256:d9b5e780…`, in `scripts/api_check.sh`; `scripts/ci/test_ci_scripts.sh` checks the pin). 6.1.3 is the newest published image, and the collection also passes on newman 6.2.3.

```bash
make api-check-prod
```

This runs only the GET requests against production. `API_WRITES=1 make api-check-prod` also runs the writes. The live database keeps what they make: two patient rows named "Reviewer …" and one cancelled appointment. Nothing removes them.

## The journey

| Folder | What it shows |
|---|---|
| 01 Health | `/health`, `/ready` and the error catalogue |
| 02 Doctors | The seeded doctors; the first is used from here on |
| 03 Slots | Free slots on the first day from tomorrow with at least two, found by asking a day at a time (up to 14). It works when sent on its own, and fails with a message if no day qualifies |
| 04 Book with an Idempotency-Key | A booking, its replay (same id, `Idempotent-Replayed: true`), the same key with another time (`422 IDEMPOTENCY_KEY_REUSED`), and the patient's list holding one appointment |
| 05 Double booking | A second patient on the same slot: `409 SLOT_TAKEN` |
| 06 Too soon | A booking and a reschedule to half the lead time from now: `422 BOOKING_TOO_SOON` |
| 07 Reschedule and cancel | Move (same id), repeat the move, cancel, cancel again (`409 APPOINTMENT_ALREADY_CANCELLED`), reuse the key (`409 IDEMPOTENCY_KEY_CONSUMED`) |
| 08 Change within 60 minutes | Cancel and reschedule a visit starting inside the lead time: `409 CHANGE_TOO_LATE` |
| 09 Validation errors | Bad UUID, missing fields, phone not E.164, bad `Idempotency-Key`, no UTC offset, past, off the grid, outside working hours, unknown doctor, beyond the horizon, short cancel reason, and 404s |

Every request asserts the status and the content type (`application/problem+json` for every error), checks the body against the response schema the contract declares (the Problem schema for errors), and checks the fields that matter for that step. IDs and times pass between requests in collection variables, and every time is computed from now in a pre-request script. A request whose inputs are missing (an earlier step was skipped or failed) is skipped, and the console says which variable it needed.

**Folder 08 needs a seeded appointment.** The API never books a slot inside the lead time, so no request can create the visit this folder changes. `make api-check` writes one straight into the database of its own stack and passes its id in. To send folder 08 by hand:

```bash
KEEP_STACK=1 make api-check
```

The script then prints the `baseUrl`, `writeBaseUrl` and `soonAppointmentId` to paste into the local environment (the stack is on port 18180, not 8080), and the time the seeded visit starts. That is 5 to 35 minutes after the run, and after it the requests no longer give `CHANGE_TOO_LATE`, so send them straight away. Against `make up` or production the variable is empty and the two requests are skipped.

## Postman and Insomnia

Start the API first with `make up` (Postman's local environment points at it, on port 8080; if you set `API_HOST_PORT`, change `baseUrl` and `writeBaseUrl` to match), or use the production environment.

- **Postman** (desktop or web): Import, choose the three files, pick an environment, then run the collection or send requests one by one in folder order. No cloud workspace is used.
- **Insomnia**: Import the collection file, then create an environment with `baseUrl` and, for local, `writeBaseUrl`. Without `writeBaseUrl` every request other than GET has no host. I have not verified the Insomnia import. The Insomnia CLI cannot run the file either: `inso` 13.3.1 refuses it ("Expected an Insomnia v4 export file"). Insomnia's support for Postman's `pm` script API is partial, so the tests may not all run there. newman and Postman are the checked paths.
- **newman** without make, against `make up`: `newman run docs/api/clinic-booking.postman_collection.json -e docs/api/local.postman_environment.json`.

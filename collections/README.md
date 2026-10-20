# API collection

A Postman v2.1 collection of the reviewer journey through the booking API, with two environments. The files are built from [`contracts/openapi.json`](../contracts/openapi.json) by [`scripts/api_collection.mjs`](../scripts/api_collection.mjs) (`make api-collection`); edit the script, not the JSON. CI fails when the committed files differ from a fresh build, and the build fails when a public operation in the contract is not in the journey. That check covers the contract to the collection only. Whether the contract matches the running API is the `backend-contract` job's check.

| File | What it is |
|---|---|
| `clinic-booking.postman_collection.json` | The requests, their pre-request scripts and their tests |
| `local.postman_environment.json` | `baseUrl` and `writeBaseUrl` both `http://localhost:8080`, the `make up` stack; `longLeadBaseUrl` empty (folder 08) |
| `production.postman_environment.json` | `baseUrl` `https://clinic.ericgitangu.com/api`, and no `writeBaseUrl` |

Production goes through the booking site's `/api` proxy on Vercel because Cloud Run is IAM-only. None of the public endpoints needs a token, so neither environment holds a credential.

**Reads and writes.** GET requests go to `baseUrl`. Every other request goes to `writeBaseUrl`. The production environment does not define `writeBaseUrl`, so those requests have no host: the pre-request scripts skip them, and a client that ignores the scripts sends them nowhere. A newman run with every script removed showed this: each write failed with `getaddrinfo ENOTFOUND {{writebaseurl}}`. Writes still reach production if someone sets `writeBaseUrl` to the production base themselves. The public API is unauthenticated by design (README, section 4.2), so curl can do the same.

The lead time is the configured `BOOKING_MIN_LEAD_MINUTES` (default 60 minutes). The collection reads it from the contract when it is built, so the "too soon" times and the test names follow the value the API publishes.

## Run it

```bash
make api-check
```

This needs Docker only. It brings up its own compose project (`clinic-apicheck`, on its own host ports, so a running `make up` stack is left alone), plus a second API with a 100-day lead time for folder 08 ([`scripts/api_check.compose.yml`](../scripts/api_check.compose.yml)). It runs every folder with newman and removes the stack.

Each compose stack takes one Docker network, and Docker hands those out from a fixed set of address pools (about 30 networks by default). When stacks left on the machine have used them all, the script stops before `up` and says so. `docker network prune` frees the networks no container uses, and `docker compose -p <name> down -v` removes a stack you no longer need.

The host ports default to the first free ones from 18180 (API), 18181 (the long-lead API) and 15532 (Postgres), so a second run or another stack on the same machine does not collide. `API_CHECK_API_PORT`, `API_CHECK_LONG_LEAD_PORT` and `API_CHECK_DB_PORT` set them, and `API_CHECK_PROJECT` names the compose project. A local run fails if any request was skipped, because newman alone would report a skipped step as passed. newman runs from `postman/newman:6.1.3-alpine` pinned by digest (`sha256:d9b5e780…`, in `scripts/api_check.sh`; `scripts/ci/test_ci_scripts.sh` checks the pin). 6.1.3 is the newest published image, and the collection also passes on newman 6.2.3.

```bash
make api-check-prod
```

This runs only the GET requests against production. `API_WRITES=1 make api-check-prod` also runs the writes. The live database keeps what they make: two patient rows named "Reviewer …" and two cancelled appointments. Nothing removes them.

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
| 08 Change inside the lead time | Book a visit, then cancel and reschedule it through the long-lead API: `409 CHANGE_TOO_LATE`; then cancel it through the normal API |
| 09 Validation errors | Bad UUID, missing fields, phone not E.164, bad `Idempotency-Key`, no UTC offset, past, off the grid, outside working hours, unknown doctor, beyond the horizon, short cancel reason, and 404s |

Every request asserts the status and the content type (`application/problem+json` for every error), checks the body against the response schema the contract declares (the Problem schema for errors), and checks the fields that matter for that step. IDs and times pass between requests in collection variables, and every time is computed from now in a pre-request script. A request whose inputs are missing (an earlier step was skipped or failed) is skipped, and the console says which variable it needed.

**Folder 08 uses a second API.** The API never books a visit inside its own lead time, and inside the lead time from now there may be no working hours at all, so no request to the normal API can produce a visit that is too close to change. `make api-check` therefore starts a second API on the same database whose only difference is `BOOKING_MIN_LEAD_MINUTES=144000` (100 days). The folder books a visit through the normal API, then asks the second API to cancel and reschedule it, and gets `409 CHANGE_TOO_LATE` from the same code and the same rule. The normal API then cancels it, which shows the visit was otherwise changeable. Nothing is written to the database outside the API. The second API's setting is the one allowed exception to the repository's rule that no config sets another lead time: the contract test `test_change_window_constant.py` names that file and its value, and fails if a deploy file, Dockerfile or other script references it. To send folder 08 by hand:

```bash
KEEP_STACK=1 make api-check
```

The script then prints `baseUrl`, `writeBaseUrl` and `longLeadBaseUrl` to paste into the local environment, with the ports it used. Against `make up` or production, `longLeadBaseUrl` is empty and the two refusals are skipped.

## Postman and newman

newman is the runner: `make api-check`, CI and the production read pass all use it. Postman (desktop or web) is the way to click through the same file. Other tools that import Postman v2.1 collections, Insomnia among them, may load the requests, but they are not supported here: the tests use Postman's `pm` script API, which they implement only in part, and Insomnia's CLI (`inso` 13.3.1) refuses the file.

Start the API first with `make up` (the local environment points at it, on port 8080; if you set `API_HOST_PORT`, change `baseUrl` and `writeBaseUrl` to match), or use the production environment.

- **Postman**: Import, choose the three files, pick an environment, then run the collection or send requests one by one in folder order. No cloud workspace is used.
- **newman** without make, against `make up`: `newman run collections/clinic-booking.postman_collection.json -e collections/local.postman_environment.json`.

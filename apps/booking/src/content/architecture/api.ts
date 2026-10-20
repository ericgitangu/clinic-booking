import type { TabContent } from "./types";

export const API: TabContent = {
  id: "api",
  label: "API and collections",
  intro:
    "The error catalogue, the interactive API docs, and the Postman collection that walks the reviewer path against local or production.",
  cards: [
    {
      id: "api-errors",
      title: "Error catalogue",
      summary:
        "Every error code the API can return, its status, and what a client should do.",
      blocks: [
        {
          t: "p",
          text: "Every non-2xx response is `application/problem+json` (RFC 9457 problem details) with a stable `code` and a `request_id`. The `type` is `{PUBLIC_BASE_URL}/problems/<slug>`, where the slug is the code in lower case with dashes. The catalogue is checked against the code by a test, so a code the API can emit is in this table ([the REST contract decision](/decisions#rest-and-errors)).",
        },
        {
          t: "p",
          text: "The status rule: **404** means the resource in the path does not exist. **422** means the request is well formed but invalid, so resending it unchanged can never succeed. **409** means it conflicts with the current state and may succeed later or in another state.",
        },
        {
          t: "table",
          caption:
            "All 40 codes. The lead time is `BOOKING_MIN_LEAD_MINUTES`, 60 minutes by default.",
          head: [
            "Code",
            "HTTP status",
            "When it happens",
            "What the client should do",
          ],
          rows: [
            [
              "`UNAUTHENTICATED`",
              "401",
              "The internal assertion is missing, malformed, expired or does not match the request.",
              "Sign a fresh assertion and resend. A browser never sees this on the public API.",
            ],
            [
              "`FORBIDDEN`",
              "403",
              "The assertion is valid but its role may not use this endpoint.",
              "Do not retry. Use a role that is allowed, or hide the action.",
            ],
            [
              "`ASSERTION_REPLAYED`",
              "401",
              "The same signed request was already used once.",
              "Sign a new assertion for each write and resend.",
            ],
            [
              "`ROLE_ESCALATION`",
              "403",
              "The caller's role may not change this access: an admin cannot change or revoke an admin, and nobody changes their own access.",
              "Do not retry. Ask an owner.",
            ],
            [
              "`CLIENT_ADDRESS_UNKNOWN`",
              "400",
              "The request carries no usable client address, so it cannot be rate limited.",
              "Retry.",
            ],
            [
              "`VALIDATION_ERROR`",
              "422",
              "Schema or type errors, extra fields, a bad UUID or date, a datetime that is not a string, or a malformed `Idempotency-Key` (not 1 to 255 visible ASCII characters).",
              "Fix the request. Resending it unchanged cannot succeed.",
            ],
            [
              "`TIMEZONE_REQUIRED`",
              "422",
              "The datetime has no UTC offset and nothing else is wrong.",
              "Send the time with an offset.",
            ],
            [
              "`UNKNOWN_DOCTOR`",
              "422",
              "The body names a doctor that does not exist or is inactive.",
              "Pick a doctor from the list and resend.",
            ],
            [
              "`UNKNOWN_PATIENT`",
              "422",
              "The body names a patient that does not exist.",
              "Use a real patient id.",
            ],
            [
              "`SLOT_IN_PAST`",
              "422",
              "`starts_at` is at or before now.",
              "Choose a later time.",
            ],
            [
              "`BOOKING_TOO_SOON`",
              "422",
              "A booking, or a reschedule's new time, starts less than the minimum lead time ahead (`BOOKING_MIN_LEAD_MINUTES`, 60 by default).",
              "Choose a later time.",
            ],
            [
              "`DATE_OUT_OF_RANGE`",
              "422",
              "The clinic-local date is beyond the booking horizon.",
              "Choose an earlier date.",
            ],
            [
              "`SLOT_MISALIGNED`",
              "422",
              "The time is off the 30 minute grid of a working window, or has non-zero seconds or microseconds.",
              "Round to a slot start from the availability list.",
            ],
            [
              "`OUTSIDE_WORKING_HOURS`",
              "422",
              "The 30 minutes from the start do not fit inside a working window.",
              "Choose a time inside working hours.",
            ],
            [
              "`IDEMPOTENCY_KEY_REUSED`",
              "422",
              "The `Idempotency-Key` was already used with a different doctor or time.",
              "Use a new key for the new doctor or time.",
            ],
            [
              "`SLOT_TAKEN`",
              "409",
              "Another booking holds this doctor's slot (`uq_appt_doctor_slot_booked`).",
              "Refresh availability and pick another slot.",
            ],
            [
              "`PATIENT_DOUBLE_BOOKED`",
              "409",
              "The patient already has a booking at this time (`uq_appt_patient_slot_booked`).",
              "Pick a different time or cancel the other booking.",
            ],
            [
              "`APPOINTMENT_ALREADY_CANCELLED`",
              "409",
              "Cancel or reschedule of an appointment that is already cancelled.",
              "Stop. Book again if needed.",
            ],
            [
              "`CHANGE_TOO_LATE`",
              "409",
              "Changing or cancelling a visit that starts less than the minimum lead time from now. A reschedule's new time is `BOOKING_TOO_SOON` instead. Staff routes never return it.",
              "Do not retry. Do not offer cancel or reschedule inside the window; tell the person to call the clinic.",
            ],
            [
              "`APPOINTMENT_ALREADY_STARTED`",
              "409",
              "Cancel or reschedule when `starts_at` is at or before now.",
              "Stop. The visit has begun.",
            ],
            [
              "`PATIENT_PHONE_EXISTS`",
              "409",
              "Another patient already uses this phone number (`uq_patients_phone`).",
              "Use the existing patient or a different number.",
            ],
            [
              "`CONCURRENT_UPDATE`",
              "409",
              "A deadlock or serialization failure persisted after one retry.",
              "Retry after a short delay.",
            ],
            [
              "`RATE_LIMITED`",
              "429",
              "Too many requests from this address, or too many staff changes by this person in the current window.",
              "Wait the number of seconds in `Retry-After`, then try again.",
            ],
            [
              "`IDEMPOTENCY_KEY_CONSUMED`",
              "409",
              "The `Idempotency-Key` belongs to an appointment that is no longer booked.",
              "Use a new key.",
            ],
            [
              "`APPOINTMENT_LOCKED`",
              "409",
              "Staff vetoed the last change to this appointment, so only staff can change it until an owner or admin unlocks it.",
              "Do not retry. Tell the person to contact the clinic.",
            ],
            [
              "`ATTENDANCE_WINDOW_CLOSED`",
              "409",
              "Arrival can be recorded from 15 minutes before the appointment to 2 hours after it starts, and no-show from the start to 2 hours after. Outside those windows neither can.",
              "Do not retry; record it inside the window.",
            ],
            [
              "`NOTHING_TO_VETO`",
              "409",
              "The appointment's latest change was not made by the patient or is already undone, or an unlock was asked for an appointment that is not locked.",
              "Refresh the appointment and check its state.",
            ],
            [
              "`ACCESS_EXISTS`",
              "409",
              "This email already has active access.",
              "Change its role instead.",
            ],
            [
              "`OWNER_PROTECTED`",
              "409",
              "The owner's access is fixed by configuration and cannot be granted, changed or revoked.",
              "Do not retry.",
            ],
            [
              "`INVITE_INVALID`",
              "404",
              "The invitation does not exist, was used, was revoked or expired, or was sent to another email. Every reason returns the same body.",
              "Ask for a new invitation.",
            ],
            [
              "`ACCESS_NOT_FOUND`",
              "404",
              "No active access for this email.",
              "Check the email address.",
            ],
            [
              "`DOCTOR_NOT_FOUND`",
              "404",
              "No such doctor, including inactive ones.",
              "Check the id.",
            ],
            ["`PATIENT_NOT_FOUND`", "404", "No such patient.", "Check the id."],
            [
              "`APPOINTMENT_NOT_FOUND`",
              "404",
              "No such appointment.",
              "Check the id.",
            ],
            [
              "`PROBLEM_NOT_FOUND`",
              "404",
              "No such problem slug.",
              "Check the slug in the error `type`.",
            ],
            [
              "`NOT_FOUND`",
              "404",
              "The path resource does not exist.",
              "Check the path.",
            ],
            [
              "`METHOD_NOT_ALLOWED`",
              "405",
              "The method is not allowed on this path.",
              "Use a method the path accepts.",
            ],
            [
              "`REALTIME_UNAVAILABLE`",
              "503",
              "Live updates are off: not configured, or this month's publish budget is spent.",
              "Poll instead.",
            ],
            [
              "`DB_UNAVAILABLE`",
              "503",
              "A connection failure or pool timeout.",
              "Retry after a short delay.",
            ],
            [
              "`INTERNAL_ERROR`",
              "500",
              "An unexpected error. Any `ck_*` constraint violation lands here as a bug.",
              "Report it with the `request_id`.",
            ],
          ],
        },
        {
          t: "p",
          text: "**One rule worth knowing: the one-hour rule.** Cancel and reschedule are refused with `409 CHANGE_TOO_LATE` when the appointment's current start is less than 60 minutes away; exactly 60 is allowed. Book, and a reschedule's new start, are validated as a fresh booking and give `422 BOOKING_TOO_SOON`. See [the one-hour rule](/decisions#one-hour-rule).",
        },
        {
          t: "p",
          text: "**Idempotency.** `Idempotency-Key` is read on `POST /appointments` and `POST /internal/me/appointments`, scoped to the patient. The same key with the same doctor and time replays the booking with `Idempotent-Replayed: true`. A different doctor or time is `IDEMPOTENCY_KEY_REUSED`. A key whose appointment has left the booked state is `IDEMPOTENCY_KEY_CONSUMED`.",
        },
        {
          t: "p",
          text: "**Realtime tokens.** `CLIENT_ADDRESS_UNKNOWN` (400) when the proxy sent no usable `x-client-ip`; the API never guesses one from the socket. `RATE_LIMITED` (429, with `Retry-After`) when an address uses too many tokens in a minute or a day. `REALTIME_UNAVAILABLE` (503) when push is not configured or the month's publish budget is spent, so the client polls.",
        },
      ],
    },
    {
      id: "swagger-redoc",
      title: "Swagger UI, ReDoc and the OpenAPI file",
      summary:
        "Three ways into the same contract, all served from the booking site.",
      blocks: [
        {
          t: "ul",
          items: [
            "[/docs](/docs): Swagger UI against the real API. You can use Try it out without signing in, because the public endpoints need no token.",
            "[/redoc](/redoc): ReDoc, a read-only reference of the same contract that is easier to scan.",
            "[/openapi.json](/openapi.json): the OpenAPI 3.1 file itself, for generating a client or importing into another tool.",
          ],
        },
        {
          t: "p",
          text: "Swagger UI and ReDoc are self-hosted: their bundles are copied into the site's own assets, and the pages load nothing from another origin. The `/internal/*` endpoints are in the contract but are not callable from Swagger, because they need a signed assertion.",
        },
      ],
    },
    {
      id: "api-collection",
      title: "API collection: newman and Postman",
      summary:
        "A reviewer journey through the API, runnable in Postman or with newman.",
      blocks: [
        {
          t: "p",
          text: "The collection is a Postman v2.1 file that walks the booking API in order: health, doctors, free slots, a booking with an `Idempotency-Key` and its replay, a double booking, a time that is too soon, reschedule and cancel, a change inside the lead time, and the validation errors. Every request checks the status, the content type (`application/problem+json` for errors), the key fields, and the body against the schema in the contract. Times are computed from now, so it does not go stale. It is built from the OpenAPI contract by a script, and CI fails if the committed files differ from a fresh build.",
        },
        {
          t: "table",
          caption: "The two environments. Neither holds a credential.",
          head: ["Environment", "Values"],
          rows: [
            [
              "`local`",
              "`baseUrl` and `writeBaseUrl` both `http://localhost:8080` (the `make up` stack); `longLeadBaseUrl` empty",
            ],
            [
              "`production`",
              "`baseUrl` `https://clinic.ericgitangu.com/api` (through the booking site's proxy, because Cloud Run is IAM-only); no `writeBaseUrl`",
            ],
          ],
        },
        {
          t: "p",
          text: "GET requests go to `baseUrl`; every other request goes to `writeBaseUrl`. The production environment leaves `writeBaseUrl` out on purpose, so the writes have no host and go nowhere unless someone sets it themselves. The public API is unauthenticated by design, so curl can do the same.",
        },
        {
          t: "p",
          text: "**Run it.**",
        },
        {
          t: "ol",
          items: [
            "For a full local run with Docker only, run `make api-check`. It starts its own compose project and a second API with a 100 day lead time for the change-inside-the-lead-time folder, runs every folder with newman, and removes the stack.",
            'To read production only, run `make api-check-prod`. It sends only GET requests. `API_WRITES=1 make api-check-prod` also runs the writes, which leave two patient rows named "Reviewer ..." and two cancelled appointments in the live database.',
            "To click through it in Postman, start the API with `make up` (or pick the production environment), import the collection and an environment, then run the folders in order.",
            "To run newman by hand against `make up`, use the command below.",
          ],
        },
        {
          t: "code",
          lang: "bash",
          code: `make api-check`,
          caption: "Local, Docker only.",
        },
        {
          t: "code",
          lang: "bash",
          code: `make api-check-prod
API_WRITES=1 make api-check-prod   # also runs the writes`,
          caption: "Production.",
        },
        {
          t: "code",
          lang: "bash",
          code: `newman run collections/clinic-booking.postman_collection.json \\
  -e collections/local.postman_environment.json`,
          caption: "newman by hand, against the `make up` stack.",
        },
        {
          t: "table",
          caption: "The nine folders of the journey, in the order they run.",
          head: ["Folder", "What it shows"],
          rows: [
            ["01 Health", "`/health`, `/ready` and the error catalogue."],
            [
              "02 Doctors",
              "The seeded doctors. The first is used from here on.",
            ],
            [
              "03 Slots",
              "Free slots on the first day from tomorrow that has at least two, found a day at a time, up to 14 days.",
            ],
            [
              "04 Book with an Idempotency-Key",
              "A booking, its replay (same id, `Idempotent-Replayed: true`), the same key with another time (`422 IDEMPOTENCY_KEY_REUSED`), and the patient's list.",
            ],
            [
              "05 Double booking",
              "A second patient on the same slot gets `409 SLOT_TAKEN`.",
            ],
            [
              "06 Too soon",
              "A booking and a reschedule inside the lead time get `422 BOOKING_TOO_SOON`.",
            ],
            [
              "07 Reschedule and cancel",
              "Move, repeat the move, cancel, cancel again (`409 APPOINTMENT_ALREADY_CANCELLED`), reuse the key (`409 IDEMPOTENCY_KEY_CONSUMED`).",
            ],
            [
              "08 Change inside the lead time",
              "Cancel and reschedule a visit through a second API with a 100 day lead time and get `409 CHANGE_TOO_LATE`.",
            ],
            [
              "09 Validation errors",
              "Bad ids, missing fields, a time without an offset, off the grid, outside working hours, unknown doctor, and 404s.",
            ],
          ],
        },
        {
          t: "p",
          text: "Folder 08 needs a second API because the normal API never books a visit inside its own lead time, so no request to it can produce one that is too close to change. `make api-check` starts that second API on the same database, with only the minimum lead time different (100 days, set in the compose file that only api-check uses). To send folder 08 by hand, run `KEEP_STACK=1 make api-check` and paste the base URLs it prints into the local environment. Against `make up` or production, folder 08's two refusals are skipped.",
        },
        {
          t: "code",
          lang: "bash",
          code: `KEEP_STACK=1 make api-check`,
          caption: "Keep the stack up so folder 08 can be sent by hand.",
        },
        {
          t: "p",
          text: "The files are in the repository: [the collections folder on GitHub](https://github.com/ericgitangu/clinic-booking/tree/main/collections). Postman and newman are the supported tools; other tools that import Postman collections may load the requests but the tests use Postman's `pm` script API, which they implement only in part.",
        },
      ],
    },
  ],
};

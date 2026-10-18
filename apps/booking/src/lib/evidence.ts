// What the landing page claims about the API, each claim next to the place a reviewer can check
// it. The tests read this table against contracts/openapi.json and the generated problem codes, so
// a path, a Swagger link or an error code that stops existing fails the build.
export const GITHUB = "https://github.com/ericgitangu/clinic-booking";
export const README = `${GITHUB}/blob/main/README.md`;
export const ADR = (file: string) => `${GITHUB}/blob/main/docs/adr/${file}`;

export type Evidence = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  // The contract's tag and operationId, which together make the Swagger deep link.
  tag: string;
  operationId: string;
  summary: string;
  // Problem codes this operation can return, with the HTTP status of each.
  errors: { status: number; code: string }[];
  screen: { href: string; label: string };
};

export const swaggerLink = (e: Pick<Evidence, "tag" | "operationId">) =>
  `/docs#/${e.tag}/${e.operationId}`;

const BOOK = { href: "/book", label: "Book a visit" };
const MINE = { href: "/appointments", label: "My appointments" };

export const REQUIRED: Evidence[] = [
  {
    method: "POST",
    path: "/appointments",
    tag: "appointments",
    operationId: "create_appointment_appointments_post",
    summary:
      "Books one 30-minute slot for a patient. The time must carry an offset, fall on a free slot inside the doctor's working hours, and be at least an hour away. The database refuses a second booking of the same doctor and time.",
    errors: [
      { status: 409, code: "SLOT_TAKEN" },
      { status: 422, code: "SLOT_IN_PAST" },
      { status: 422, code: "OUTSIDE_WORKING_HOURS" },
      { status: 422, code: "TIMEZONE_REQUIRED" },
    ],
    screen: BOOK,
  },
  {
    method: "GET",
    path: "/doctors/{doctor_id}/availability",
    tag: "doctors",
    operationId: "doctor_availability_doctors__doctor_id__availability_get",
    summary:
      "The free 30-minute slots for one doctor on one date, in Nairobi time: working hours minus what is already booked.",
    errors: [
      { status: 404, code: "DOCTOR_NOT_FOUND" },
      { status: 422, code: "DATE_OUT_OF_RANGE" },
    ],
    screen: BOOK,
  },
  {
    method: "PATCH",
    path: "/appointments/{appointment_id}/cancel",
    tag: "appointments",
    operationId:
      "cancel_appointment_appointments__appointment_id__cancel_patch",
    summary:
      "Cancels an appointment. A reason of 3 to 500 characters is required.",
    errors: [
      { status: 409, code: "APPOINTMENT_ALREADY_CANCELLED" },
      { status: 409, code: "CHANGE_TOO_LATE" },
      { status: 409, code: "APPOINTMENT_ALREADY_STARTED" },
      { status: 404, code: "APPOINTMENT_NOT_FOUND" },
    ],
    screen: MINE,
  },
  {
    method: "PATCH",
    path: "/appointments/{appointment_id}/reschedule",
    tag: "appointments",
    operationId:
      "reschedule_appointment_appointments__appointment_id__reschedule_patch",
    summary:
      "Moves an appointment to another free slot, under the same rules as booking.",
    errors: [
      { status: 409, code: "SLOT_TAKEN" },
      { status: 409, code: "APPOINTMENT_ALREADY_CANCELLED" },
      { status: 409, code: "CHANGE_TOO_LATE" },
      { status: 422, code: "BOOKING_TOO_SOON" },
    ],
    screen: MINE,
  },
];

export const BONUS: Evidence[] = [
  {
    method: "GET",
    path: "/patients/{patient_id}/appointments",
    tag: "patients",
    operationId: "patient_appointments_patients__patient_id__appointments_get",
    summary:
      "A patient's upcoming appointments, soonest first, each with the doctor.",
    errors: [{ status: 404, code: "PATIENT_NOT_FOUND" }],
    screen: MINE,
  },
  {
    method: "POST",
    path: "/appointments",
    tag: "appointments",
    operationId: "create_appointment_appointments_post",
    summary:
      "The one-hour rule: a booking must start at least an hour from now. Try a time 30 minutes ahead and read the answer.",
    errors: [{ status: 422, code: "BOOKING_TOO_SOON" }],
    screen: BOOK,
  },
];

export const API_BASE = "https://clinic.ericgitangu.com/api";

// The three steps of the ten-minute check, as copy-and-paste shell.
export const STEPS = [
  {
    title: "Create a patient",
    body: "A patient of your own. The response carries the id the next steps use.",
    code: `API=${API_BASE}
PATIENT=$(curl -s -X POST $API/patients -H 'content-type: application/json' \\
  -d '{"full_name":"Your Name"}' | jq -r .id)
echo $PATIENT`,
  },
  {
    title: "Book a free slot",
    body: "Pick the first doctor and the first free slot on the next day that has one, then book it. Expect 201.",
    code: `DOCTOR=$(curl -s $API/doctors | jq -r '.items[0].id')
for n in 2 3 4 5 6 7 8; do
  DAY=$(date -u -d "+$n days" +%F 2>/dev/null || date -u -v+\${n}d +%F)
  SLOT=$(curl -s "$API/doctors/$DOCTOR/availability?date=$DAY" | jq -r '.slots[0].starts_at // empty')
  [ -n "$SLOT" ] && break
done
curl -s -w '\\nHTTP %{http_code}\\n' -X POST $API/appointments -H 'content-type: application/json' \\
  -d "{\\"doctor_id\\":\\"$DOCTOR\\",\\"patient_id\\":\\"$PATIENT\\",\\"starts_at\\":\\"$SLOT\\"}"`,
  },
  {
    title: "Try to double-book it",
    body: "A second patient asks for the same slot. Expect 409 and the code SLOT_TAKEN.",
    code: `PATIENT2=$(curl -s -X POST $API/patients -H 'content-type: application/json' \\
  -d '{"full_name":"Someone Else"}' | jq -r .id)
curl -s -w '\\nHTTP %{http_code}\\n' -X POST $API/appointments -H 'content-type: application/json' \\
  -d "{\\"doctor_id\\":\\"$DOCTOR\\",\\"patient_id\\":\\"$PATIENT2\\",\\"starts_at\\":\\"$SLOT\\"}"`,
  },
] as const;

export const TILES = [
  {
    title: "One slot, one booking, enforced by the database",
    body: "FastAPI and Postgres. A partial unique index refuses a second active booking of the same doctor and time, so the guarantee holds however many requests arrive at once.",
    adr: "0003-double-booking-partial-unique-index.md",
    label: "Read the double-booking decision",
  },
  {
    title: "Cloud Run is IAM-only, behind a Vercel proxy",
    body: "Nothing public reaches the API directly. Only named service identities may call it (the web apps and a smoke-test account), and /api forwards requests with a short-lived token.",
    adr: "0023-zero-cost-edge-front-door.md",
    label: "Read the front-door decision",
  },
  {
    title: "Tested on every pull request, deployed on merge",
    body: "CircleCI runs the tests, scans and both end-to-end suites on every PR, deploys main to Cloud Run and Vercel, checks the live site, and rolls back if that check fails.",
    adr: "0016-cicd-circleci-keyless-deploy.md",
    label: "Read the CI/CD decision",
  },
  {
    title: "$0, with one stated exception",
    body: "Everything runs inside free tiers. The project shares a billing account whose other projects already used up two free tiers, so it bills about $0.28 a month. The README says so.",
    adr: "0014-hosting-region-and-cost.md",
    label: "Read the hosting and cost decision",
    extra: {
      href: `${README}#10-operations-cost--security-posture`,
      label: "README section 10",
    },
  },
] as const;

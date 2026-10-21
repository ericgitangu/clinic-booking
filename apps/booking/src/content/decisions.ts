// All the copy for /decisions lives in this file; the page only lays it out.
//
// Rules the unit test checks: 8 to 10 entries, four non-empty parts each (an entry marked
// `placeholder` is the one exception; none is in use now), no em dashes. Entry ids become the anchors
// in the page's contents list. Set DECISIONS_DRAFT to true to show the draft banner again.

export const DECISIONS_DRAFT = false;

export type Decision = {
  id: string;
  title: string;
  /** What I chose. */
  decision: string;
  /** What I gave up. */
  gaveUp: string;
  /** Why. */
  why: string;
  /** When I would revisit it. */
  revisit: string;
  /** True for an entry waiting on the engineer; only `decision` is shown. */
  placeholder?: boolean;
};

export const PLACEHOLDER_TEXT = "Decision pending engineer sign-off";

export const DECISIONS_INTRO =
  "These are the choices I would defend in a review. Each one says what I picked, what it cost me, why I picked it, and what would make me change my mind.";

export const DECISIONS: readonly Decision[] = [
  {
    id: "double-booking",
    title: "The database refuses a double booking",
    decision:
      "I put a unique index on doctor and start time, for booked appointments only. The code does not check first and does not take a lock.",
    gaveUp:
      "It only works because every slot is a fixed 30 minute block. If visits had different lengths, I would need a different kind of constraint.",
    why: "Any check I run before inserting leaves a gap where two people can both pass. The index has no gap. A cancelled appointment drops out of the index, so its slot opens up again.",
    revisit:
      "When a doctor needs visits of different lengths. Then I move to an exclusion constraint on time ranges.",
  },
  {
    id: "one-api",
    title: "One API owns every rule",
    decision:
      "One FastAPI service holds all the business rules, and one Postgres database holds the state. The web apps never write to the database.",
    gaveUp:
      "Python starts slower from cold than Go would. I turned on CPU boost to help and I have not measured the effect.",
    why: "Rules in one place cannot disagree with each other. The brief asked for an API, so the web apps are just clients of it.",
    revisit:
      "If cold starts show up for real users. I would keep one instance warm before I split anything.",
  },
  {
    id: "time",
    title: "Time is stored in UTC, the clinic zone is data",
    decision:
      "Every time is stored in UTC. The clinic's time zone is a column on the clinic. A time sent without an offset is rejected, not guessed.",
    gaveUp:
      "One extra join to read the zone. The seed data has no daylight saving zone, so those tests run in Berlin as a stand-in.",
    why: "Guessing a zone is how appointments slip by hours. The current time is passed in rather than read inside queries, so a test can pin it and pass on any day.",
    revisit:
      "When a second clinic in another zone arrives, or real data shows a case the Berlin tests missed.",
  },
  {
    id: "rest-and-errors",
    title: "Plain REST, a written contract, standard errors",
    decision:
      "The API is REST, described by an OpenAPI file. Errors use the standard Problem Details shape with a fixed list of codes. The TypeScript client is generated from that file.",
    gaveUp:
      "The types come from generated code and a CI check, not from sharing code between the two sides. The generator is pre-1.0, so I pin it. There is no /v1 in the path.",
    why: "Anyone can try the API in Swagger. The web app cannot drift from the contract without CI failing. A stable error code lets the UI say something useful, like the slot was just taken.",
    revisit:
      "When a second client needs a stable version, I add a version prefix. If the generator breaks, I look for another one.",
  },
  {
    id: "polling-then-push",
    title: "Polling first, push on top",
    decision:
      "A patient's page asks for fresh slots every 60 seconds while live push through Ably is healthy, and every 15 seconds when push is off or has dropped. It stops after 10 idle minutes.",
    gaveUp:
      "If a push message is lost, a slot can look free for up to a minute. Ably is a third party that sees slot events, which carry no patient data.",
    why: "Correctness never depends on push, because the database refuses the second booking anyway. Push makes the page feel live; the poll is the safety net that keeps it right.",
    revisit:
      "If I need push without a third party, or the free limits stop fitting.",
  },
  {
    id: "thin-web-layer",
    title: "A thin Next.js layer is the only door",
    decision:
      "The browser only talks to the Next.js server code. That code signs each request to the API with a short-lived signed assertion. People sign in with Google, and staff roles are checked in the API on every request.",
    gaveUp:
      "The public API is still open, as the brief says. Anyone who holds an appointment id can change that appointment through it. I say so in the README. Sessions are stateless cookies, so I cannot revoke one early.",
    why: "I can close the gap in the web layer without changing the contract the brief asked for. Server code means little JavaScript in the browser and nothing secret in it.",
    revisit:
      "Before any real patient data. Then the API itself has to know who is calling.",
  },
  {
    id: "hosting-and-cost",
    title: "Hosting close to the database, kept near zero",
    decision:
      "The API runs on Cloud Run in us-east4, next to the Neon database. Only the web apps' Google identities can call it. I stay inside free tiers wherever I can, and a script checks the limits on every release.",
    gaveUp:
      "I estimate 100 to 150 ms more per warm request for people in Kenya than a Frankfurt layout would add. I have not measured that. The shared billing account's free tiers were already used up, so this project costs about $0.41 a month, under a $0.50 ceiling I set.",
    why: "The API and the database should be close, because each booking makes several queries. With no public address on Cloud Run, there is one front door to watch.",
    revisit:
      "When latency is a real complaint, or real traffic puts the free tiers at risk.",
  },
  {
    id: "go",
    title: "A small Go service for the staff live feed",
    decision:
      "A small Go service streams the booking log to the staff dashboard. It only reads: its database role can select a few columns and nothing else, and every write still goes through FastAPI. It is deployed and serving the live feed.",
    gaveUp:
      "A second runtime to build, scan and deploy. Below 1 vCPU, Cloud Run allows one stream per instance, and I cap it at two instances to stay at zero cost. So two staff can watch live at once. Each browser shares one stream across all its tabs, and a third person sees a busy notice while the page refreshes every 30 seconds.",
    why: "Staff events carry patient names and cancellation reasons, so they stay inside our Google Cloud boundary instead of going through a third party. A separate service means open streams can never use up the API's capacity and slow down booking. Go gives a small image and a fast cold start, which matter on a service that scales to zero.",
    revisit:
      "When more than two staff need the live view at once, or there is more than one clinic. Then fan-out moves to Pub/Sub or Redis inside Google Cloud, so a viewer no longer holds an instance.",
  },
  {
    id: "one-hour-rule",
    title: "The one-hour rule, with two different errors",
    decision:
      "A patient cannot book or move to a slot less than an hour away, and cannot change or cancel a visit that starts within the hour. Booking too soon is a 422 BOOKING_TOO_SOON; changing too late is a 409 CHANGE_TOO_LATE. Staff are exempt.",
    gaveUp:
      "Two codes for what looks like one rule, and a client has to handle both.",
    why: "They mean different things. A 422 says the request itself is wrong, so pick another time. A 409 says the request was fine but the appointment's state no longer allows it. The UI gives each its own message.",
    revisit:
      "If the clinic wants a different window per doctor or per kind of visit.",
  },
  {
    id: "veto-and-lock",
    title: "Staff can veto a patient's change, and it is audited",
    decision:
      "When a patient reschedules or cancels, staff can veto it. The change is undone and the appointment is locked, so the patient cannot change it again. Every staff action needs a reason, which goes into an append-only audit table, and shows on the live feed.",
    gaveUp:
      "A locked visit can only be changed by staff, so a patient with a real reason has to call. The audit table only grows.",
    why: "A clinic needs to stop a patient bumping a visit it has planned around, and needs to know who did what and why. Append-only means the record cannot be quietly edited.",
    revisit:
      "If patients need a way to ask for a change on a locked visit from the app.",
  },
];

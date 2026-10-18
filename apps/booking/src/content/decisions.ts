// ALL the copy for /decisions lives in this file. Edit it directly; the page only lays it out.
//
// STATUS: DRAFT. Every entry below was drafted for the engineer to rewrite in his own words
// (first person, short sentences, concrete). Nothing here is signed off yet.
// To publish: reword what you want to change, then set DECISIONS_DRAFT to false. That one flag
// removes the "Draft pending the engineer's edit" banner from the page.
//
// Rules the unit test checks: 8 to 10 entries, four non-empty parts each (an entry marked `placeholder`
// is the one exception; none is in use now), no em dashes. Entry ids become the anchors in the page's contents list.

export const DECISIONS_DRAFT = true;

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
    id: "computed-slots",
    title: "Free slots are worked out, not stored",
    decision:
      "When someone asks for a day, I take the doctor's working hours, cut them into 30 minute steps, and remove the times already booked.",
    gaveUp:
      "There is no slot row to lock. So the uniqueness rule has to live on the appointment, not on the slot.",
    why: "Nothing to generate ahead of time and nothing to clean up. If working hours change, the slots change straight away. Two indexed queries answer each request.",
    revisit:
      "If slot length varied by doctor or the calculation got hard to reason about.",
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
      "A patient's page asks for fresh slots every 15 seconds while it is visible. Live push through Ably sits on top of that, and polling still works if push fails.",
    gaveUp:
      "A slot can look free for up to 15 seconds after someone takes it. Ably is a third party that sees slot events. They carry no patient data.",
    why: "Correctness never depends on push, because the database refuses the second booking anyway. A stream that stays open would keep servers and the database awake, and I want this to cost nothing.",
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
      "The API runs on Cloud Run in us-east4, next to the Neon database. Only the Vercel project can reach it. I stay inside free tiers wherever I can.",
    gaveUp:
      "I estimate 100 to 150 ms more per warm request for people in Kenya than a Frankfurt layout would add. I have not measured that. The shared billing account also carries about $0.34 a month.",
    why: "The API and the database should be close, because each booking makes several queries. With no public address on Cloud Run, there is one front door to watch.",
    revisit:
      "When latency is a real complaint, or real traffic puts the free tiers at risk.",
  },
  {
    id: "keyless-deploy",
    title: "Deploys with no stored cloud key",
    decision:
      "CircleCI signs in to Google Cloud with a short-lived token through workload identity federation. A release goes live by tag after a smoke test, and it rolls back on its own if the check fails.",
    gaveUp:
      "The Vercel token is still long-lived. A pipeline on main takes about 10 to 12 minutes, which is an estimate.",
    why: "There is no cloud key to leak, rotate or forget. A bad release should undo itself before I notice.",
    revisit:
      "If Vercel offers a token-less deploy, or the pipeline time starts to slow me down.",
  },
  {
    id: "go",
    title: "A small Go service for the staff live feed",
    decision:
      "I added a small Go service that streams the booking log to the staff dashboard. It only reads. Its database role can select a few columns and nothing else, and every write still goes through FastAPI.",
    gaveUp:
      "A second runtime to build, scan and deploy. Cloud Run bills while a stream is open, and below 1 vCPU it allows one stream per instance. So the service runs from zero to two instances and back to zero, and two staff can watch live at once. A third sees 'Live feed busy' and the page refreshes every 30 seconds instead. One connected hour is about 900 vCPU-seconds. The measured figure: to be measured after the first deploy.",
    why: "Booking rules and the double booking guarantee stay in one codebase with one test suite. Go only does the job it suits, many long-lived streams that sit idle and use little memory. Patient events carry no personal data, so Ably is fine for them. Staff events carry patient names and cancellation reasons. That stays inside our Google Cloud boundary: Go reads Postgres and streams to the admin app behind IAM. I first designed Go, then the plan moved everything to Ably without my sign-off. I reversed that on 2026-10-19.",
    revisit:
      "When more than two staff need the live view at once, or when there is more than one clinic. Then I move to pooled pub/sub inside Google Cloud, Pub/Sub or Redis, so a connection does not hold an instance.",
  },
];

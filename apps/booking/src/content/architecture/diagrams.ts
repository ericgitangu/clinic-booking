import type { DiagramId } from "./types";

// The pre-rendered diagrams. Sources are apps/booking/diagrams/*.mmd (the landing diagram is
// content/architecture.mmd's rendering); scripts/render_overview.sh writes the light and dark SVGs.
// Nothing renders Mermaid in the browser. `label` is the accessible name; the prose next to each
// diagram says the same in words.
export type Diagram = {
  id: DiagramId;
  light: string;
  dark: string;
  width: number;
  height: number;
  label: string;
};

export const DIAGRAMS: Record<DiagramId, Diagram> = {
  context: {
    id: "context",
    light: "/diagrams/context-light.svg",
    dark: "/diagrams/context-dark.svg",
    width: 778,
    height: 392,
    label:
      "System context. Patients and clinic staff reach the clinic booking system over HTTPS. The system uses Google for sign-in and reCAPTCHA Enterprise, Resend for email and Ably to push slot events. CircleCI deploys it when a change merges to main.",
  },
  containers: {
    id: "containers",
    light: "/diagrams/containers-light.svg",
    dark: "/diagrams/containers-dark.svg",
    width: 1694,
    height: 639,
    label:
      "Containers. The browser reaches the booking and admin apps on Vercel. Both exchange a Vercel identity token for a Google ID token and call clinic-api on Cloud Run, which reads and writes Neon Postgres as the clinic_app role and publishes slot events to Ably. The clinic-migrate job runs migrations as clinic_owner. The booking app sends email through Resend. CircleCI deploys the API with workload identity federation and both apps with prebuilt Vercel deploys.",
  },
  "booking-flow": {
    id: "booking-flow",
    light: "/diagrams/booking-flow-light.svg",
    dark: "/diagrams/booking-flow-dark.svg",
    width: 1675,
    height: 1076,
    label:
      "Sequence of a booking. The browser submits a doctor, a time and an attempt key. The booking app gets a reCAPTCHA assessment, then calls the API with an idempotency key. The API either replays the stored booking, rejects a reused key with 422, or inserts and answers 201, or answers 409 when the unique index says another booking holds the slot.",
  },
  "slot-push": {
    id: "slot-push",
    light: "/diagrams/slot-push-light.svg",
    dark: "/diagrams/slot-push-dark.svg",
    width: 1359,
    height: 784,
    label:
      "Sequence of a booked slot reaching other open pages. The API writes the appointment and its event in one transaction, relays the event to Ably, and advances its cursor after Ably accepts it. Another patient's browser gets a short-lived subscribe-only token, subscribes over server-sent events and applies slot_taken messages. It also polls availability every 15 seconds while the tab is visible.",
  },
  "release-pipeline": {
    id: "release-pipeline",
    light: "/diagrams/release-pipeline-light.svg",
    dark: "/diagrams/release-pipeline-dark.svg",
    width: 1207,
    height: 1062,
    label:
      "Release pipeline. A push to main runs the verify jobs, builds the image, migrates and deploys the API without traffic, checks the tagged revision, promotes it only if the commit is still the head of main, deploys both web apps, runs a public check and rolls everything back if that check fails.",
  },
  architecture: {
    id: "architecture",
    light: "/architecture-light.svg",
    dark: "/architecture-dark.svg",
    width: 1647,
    height: 1186,
    label:
      "Architecture diagram. The browser reaches the booking and admin apps on Vercel. Those call clinic-api, a FastAPI service on Cloud Run, which uses a Neon Postgres database with a partial unique index. The admin app streams the staff live feed from clinic-realtime, a read-only Go service on Cloud Run. The API publishes slot events to Ably and the patient booking page subscribes over SSE. CircleCI deploys keylessly.",
  },
};

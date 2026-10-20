// How long marking an arrival can take in the worst case, against the dashboard's maxDuration
// (app/dashboard/layout.tsx), which covers the server action's response AND the after() work that
// follows it (the email to the doctor). Every step is bounded by a timeout, and tests/
// arrival-budget.test.ts adds them up and fails if the total no longer leaves the margin, so
// raising one timeout cannot silently break the budget.
//
// The steps run one after another:
//   before the response
//     1. the role lookup (sessionInfo) for anyone but the owner: the default timeout
//     2. the mark (markAttendance): the short timeout
//     3. the re-render for revalidatePath, a new render with its own empty request cache (React
//        cache() does not carry the action's results into it): its own role lookup, then the page's
//        reads, which run together and each stop at the default timeout
//   after the response (emails/doctor-arrival.ts)
//     4. claim, reserve, send, and the result (tried twice): short timeouts, the send's own
//
// Vercel's limit for this project's plan: with fluid compute (the default) a Hobby function's
// default and maximum duration are both 300 s
// (https://vercel.com/docs/functions/configuring-functions/duration, "Duration limits"), so 120 s
// is inside the free plan.
import { DEFAULT_TIMEOUT_MS } from "@clinic/api/call";
import { SEND_TIMEOUT_MS } from "@clinic/api/mail";
import { CALL_TIMEOUT_MS } from "@/emails/ports";

export interface Step {
  name: string;
  ms: number;
}

export const ARRIVAL_STEPS: readonly Step[] = [
  { name: "role lookup", ms: DEFAULT_TIMEOUT_MS },
  { name: "mark attendance", ms: CALL_TIMEOUT_MS },
  { name: "re-render: role lookup", ms: DEFAULT_TIMEOUT_MS },
  { name: "re-render: page reads (together)", ms: DEFAULT_TIMEOUT_MS },
  { name: "email: claim", ms: CALL_TIMEOUT_MS },
  { name: "email: reserve", ms: CALL_TIMEOUT_MS },
  { name: "email: send", ms: SEND_TIMEOUT_MS },
  { name: "email: result", ms: CALL_TIMEOUT_MS },
  { name: "email: result, second try", ms: CALL_TIMEOUT_MS },
];

/** Margin kept between the worst case and maxDuration, in milliseconds. */
export const MARGIN_MS = 10_000;

export const worstCaseMs = () => ARRIVAL_STEPS.reduce((a, s) => a + s.ms, 0);

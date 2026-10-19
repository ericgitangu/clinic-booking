// The live-feed gateway of the compose stack, seen from the outside: how many streams it opened
// (its own log, `docker compose logs realtime`), and a way to take its only slot so the browser is
// refused exactly as it would be when Cloud Run has no free instance.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASSERTION_HEADER, signAssertion } from "@clinic/api/assertion";
import { SIGNING_KEY } from "./stack";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface GatewayLine {
  time: string;
  message: string;
  role?: string;
  reason?: string;
  resumed?: boolean;
  filtered?: boolean;
  events_sent?: number;
}

/** The gateway's log lines at or after `sinceMs` (epoch ms), parsed. */
export function gatewayLog(sinceMs: number): GatewayLine[] {
  // --since has one-second resolution: ask from the second before, then filter exactly.
  const since = new Date(sinceMs - 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const out = execFileSync(
    "docker",
    [
      "compose",
      "--profile",
      "realtime",
      "logs",
      "--no-color",
      "--no-log-prefix",
      "--since",
      since,
      "realtime",
    ],
    { cwd: ROOT, env: process.env, encoding: "utf8" },
  );
  const lines: GatewayLine[] = [];
  for (const raw of out.split("\n")) {
    const at = raw.indexOf("{");
    if (at < 0) continue;
    try {
      const l = JSON.parse(raw.slice(at)) as GatewayLine;
      if (Date.parse(l.time) >= sinceMs) lines.push(l);
    } catch {
      // not a log record
    }
  }
  return lines;
}

export function opened(sinceMs: number): GatewayLine[] {
  return gatewayLog(sinceMs).filter((l) => l.message === "stream opened");
}

const REALTIME = (process.env.E2E_REALTIME_URL ?? "").replace(/\/+$/, "");

/**
 * Open a stream straight to the gateway as `email` (who must hold `role`), and keep it open until
 * the returned function is called. The local gateway has one slot, so while this holds it the
 * admin app's stream is refused.
 */
export async function holdSlot(
  email: string,
  role: string,
): Promise<() => Promise<void>> {
  const ctl = new AbortController();
  const res = await fetch(`${REALTIME}/stream`, {
    headers: {
      accept: "text/event-stream",
      [ASSERTION_HEADER]: signAssertion(
        {
          sub: `e2e-${email}`,
          email,
          role,
          emailVerified: true,
          method: "GET",
          path: "/stream",
          body: "",
          now: new Date(),
        },
        SIGNING_KEY,
      ),
    },
    signal: ctl.signal,
  });
  if (res.status !== 200 || !res.body) {
    throw new Error(`could not take the gateway's slot: ${res.status}`);
  }
  const reader = res.body.getReader();
  const first = await reader.read();
  if (!new TextDecoder().decode(first.value).includes("event: hello")) {
    throw new Error("the held stream did not start with hello");
  }
  // Keep reading, so the gateway's heartbeats never back up.
  void (async () => {
    try {
      for (;;) if ((await reader.read()).done) return;
    } catch {
      // aborted
    }
  })();
  return async () => {
    ctl.abort();
  };
}

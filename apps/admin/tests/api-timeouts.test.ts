import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The calls on the way to the arrival email (the session's role, the mark, the claim of the
// notification and the result of the send) are cut off at the short timeout the rest of the send
// path uses. The timeout is made short here (150 ms) and the API answers after 2 s: with the 15 s
// default the calls would wait for the answer and succeed. Each test also checks that the request
// REACHED the slow server, so a call that failed before it was sent does not pass for a timeout.
vi.mock("@/emails/ports", () => ({ CALL_TIMEOUT_MS: 150 }));

import {
  claimDoctorNotice,
  finishDoctorNotice,
  markAttendance,
  sessionInfo,
} from "@/lib/api";

const ID = "6f0c1a52-3f0e-4c0e-9d57-0b6f1c2f8a11";
const caller = {
  sub: "s",
  email: "admin@clinic.test",
  role: "admin",
  emailVerified: true,
} as never;
let api: Server;
let hits: string[];

beforeEach(async () => {
  hits = [];
  api = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ send: null }));
    }, 2000);
  });
  await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
  const port = (api.address() as { port: number }).port;
  vi.stubEnv("API_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("INTERNAL_SIGNING_KEY", "k".repeat(40));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  api.closeAllConnections();
  await new Promise((ok) => api.close(ok));
});

const calls: [string, () => Promise<unknown>, RegExp][] = [
  [
    "the claim of the notification",
    () => claimDoctorNotice(caller, ID),
    /POST .*doctor-notifications\/.*\/claim/,
  ],
  [
    "the result of the send",
    () => finishDoctorNotice(caller, ID, { attempt: 1, outcome: "sent" }),
    /POST .*doctor-notifications\/.*\/finish/,
  ],
  [
    "the mark of an arrival",
    () => markAttendance(caller, ID, "arrived", "at the desk"),
    /POST .*\/arrived/,
  ],
  ["the session's role", () => sessionInfo(caller), /GET .*\/session/],
];

describe("the calls on the way to the doctor email keep to the short timeout", () => {
  it.each(calls)("%s gives up on a slow API", async (_name, call, route) => {
    const began = Date.now();
    const res = (await call()) as {
      ok: boolean;
      code?: string;
      status?: number;
    };
    expect(res.ok).toBe(false);
    // The request was sent (the server saw it), and what failed was the wait for the answer.
    expect(hits.some((h) => route.test(h))).toBe(true);
    expect(res.code).toBe("UPSTREAM_UNREACHABLE");
    expect(res.status).toBe(503);
    expect(Date.now() - began).toBeLessThan(1500);
  });
});

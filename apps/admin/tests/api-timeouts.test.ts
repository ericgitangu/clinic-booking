import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The calls of the arrival path (the mark, the claim of the notification and the result of the
// send) are cut off at the short timeout the rest of the send path uses. The timeout is made short
// here (150 ms) and the API answers after 2 s: with the 15 s default the calls would wait for the
// answer and succeed. Each test also checks that the request REACHED the slow server, so a call
// that failed before it was sent does not pass for a timeout. The role lookup is the exception: it
// keeps the default, and a test says so, with the value it passes.
vi.mock("@/emails/ports", () => ({ CALL_TIMEOUT_MS: 150 }));

// What each call passes as its timeout, recorded as it goes to the real callApi.
const passed = vi.hoisted(
  () => [] as { operation: string; timeoutMs: number | undefined }[],
);
vi.mock("@clinic/api/call", async (original) => {
  const real = await original<typeof import("@clinic/api/call")>();
  return {
    ...real,
    callApi: ((
      operation: string,
      run: never,
      opts?: { timeoutMs?: number },
    ) => {
      passed.push({ operation, timeoutMs: opts?.timeoutMs });
      return real.callApi(operation, run, opts as never);
    }) as typeof real.callApi,
  };
});

import { DEFAULT_TIMEOUT_MS } from "@clinic/api/call";
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
  passed.length = 0;
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

const short: [string, () => Promise<unknown>, RegExp][] = [
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
];

describe("the calls on the arrival path keep to the short timeout", () => {
  it.each(short)("%s gives up on a slow API", async (_name, call, route) => {
    const began = Date.now();
    const res = (await call()) as {
      ok: boolean;
      code?: string;
      status?: number;
    };
    const took = Date.now() - began;
    expect(res.ok).toBe(false);
    // The request was sent (the server saw it) and the wait for the answer was what ended it: it
    // took about the timeout (150 ms), not less (which a refused or reset connection would) and
    // not the 2 s the server needed.
    expect(hits.some((h) => route.test(h))).toBe(true);
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1500);
    expect(res.code).toBe("UPSTREAM_UNREACHABLE");
  });
});

describe("the role lookup keeps the default timeout", () => {
  it("waits for a slow API instead of giving up at the short timeout", async () => {
    // Every page and every action resolves the role through this call, and a cold API can take
    // longer than the short timeout: it must not be cut at 150 ms (5 s for real).
    const began = Date.now();
    const res = (await sessionInfo(caller)) as { ok: boolean };
    expect(hits.some((h) => /GET .*\/session/.test(h))).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(1900); // it waited for the 2 s answer
    expect(res.ok).toBe(false); // the stub answers with something that is not a session
  });

  it("passes DEFAULT_TIMEOUT_MS exactly, the value the budget counts", async () => {
    await sessionInfo(caller);
    expect(passed).toEqual([
      { operation: "sessionInfo", timeoutMs: DEFAULT_TIMEOUT_MS },
    ]);
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });
});

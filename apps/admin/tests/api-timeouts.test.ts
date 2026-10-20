import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The claim and finish calls of the doctor's arrival email are cut off at the short timeout the
// rest of the send path uses. The timeout is made short here (150 ms) and the API answers after
// 2 s: with the 15 s default the calls would wait for the answer and succeed.
vi.mock("@/emails/ports", () => ({ CALL_TIMEOUT_MS: 150 }));

import { claimDoctorNotice, finishDoctorNotice } from "@/lib/api";

const ID = "6f0c1a52-3f0e-4c0e-9d57-0b6f1c2f8a11";
const caller = {
  sub: "s",
  email: "admin@clinic.test",
  role: "admin",
  emailVerified: true,
} as never;
let api: Server;

beforeEach(async () => {
  api = createServer((_req, res) => {
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

describe("the doctor email's API calls keep to the short timeout", () => {
  it("gives up on a slow claim", async () => {
    const began = Date.now();
    const res = await claimDoctorNotice(caller, ID);
    expect(res.ok).toBe(false);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it("gives up on a slow result", async () => {
    const began = Date.now();
    const res = await finishDoctorNotice(caller, ID, {
      attempt: 1,
      outcome: "sent",
    });
    expect(res.ok).toBe(false);
    expect(Date.now() - began).toBeLessThan(1500);
  });
});

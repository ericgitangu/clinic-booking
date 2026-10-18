import { expect, test } from "@playwright/test";
import { pick } from "./api";

// The live-updates token route through the real proxy (this app's /api route) to the real API and
// database. Without a push key the API answers a request that passes every check with 503
// REALTIME_UNAVAILABLE; with one (CI's ably-ci context, or the local stand-in) it answers 200 and a
// token. Either answer proves the request got all the way through.
const PUSH_ON = !!process.env.ABLY_API_KEY || !!process.env.E2E_PUSH_LOCAL;
const THROUGH = PUSH_ON ? 200 : 503;
const PATH = "/api/realtime/token/patient";
const SITE = "http://localhost:3100";

test("a cross-site Origin is refused at the proxy; this site's own Origin reaches the API", async ({
  request,
}) => {
  const { doctorId, day } = await pick(6);
  const data = { doctor_id: doctorId, date: day };

  const foreign = await request.post(PATH, {
    data,
    headers: { origin: "https://evil.example" },
  });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).code).toBe("FORBIDDEN");
  expect(foreign.headers()["cache-control"]).toBe("no-store");

  const own = await request.post(PATH, { data, headers: { origin: SITE } });
  expect(own.status()).toBe(THROUGH);
  if (!PUSH_ON) expect((await own.json()).code).toBe("REALTIME_UNAVAILABLE");
  expect(own.headers()["cache-control"]).toBe("no-store");
});

test("a client cannot choose the address the API sees", async ({ request }) => {
  const { doctorId, day } = await pick(6);
  // The API answers 400 for an unusable x-client-ip. The proxy drops the client's header and sets
  // its own, so a garbage value never arrives and the request reaches the 503.
  const res = await request.post(PATH, {
    data: { doctor_id: doctorId, date: day },
    headers: { origin: SITE, "x-client-ip": "not-an-ip" },
  });
  expect(res.status()).toBe(THROUGH);
  expect(res.headers()["cache-control"]).toBe("no-store");
});

test("every answer of the token route is no-store, whatever the status", async ({
  request,
}) => {
  const { doctorId, day } = await pick(6);
  const cases: [Record<string, unknown>, number][] = [
    [{ doctor_id: "nope", date: day }, 422],
    // Checked after the key: with push off it is 503; with push on the date itself is refused.
    [{ doctor_id: doctorId, date: "2020-01-01" }, PUSH_ON ? 422 : 503],
  ];
  for (const [data, status] of cases) {
    const res = await request.post(PATH, { data, headers: { origin: SITE } });
    expect(res.status()).toBe(status);
    expect(res.headers()["cache-control"]).toBe("no-store");
  }
});

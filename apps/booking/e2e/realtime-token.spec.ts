import { expect, test } from "@playwright/test";
import { pick } from "./api";

// The live-updates token route through the real proxy (this app's /api route) to the real API and
// database. The compose API runs without a push key, so a request that passes every check ends in
// 503 REALTIME_UNAVAILABLE: that answer proves it got all the way through.
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
  expect(own.status()).toBe(503);
  expect((await own.json()).code).toBe("REALTIME_UNAVAILABLE");
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
  expect(res.status()).toBe(503);
  expect(res.headers()["cache-control"]).toBe("no-store");
});

test("every answer of the token route is no-store, whatever the status", async ({
  request,
}) => {
  const { doctorId, day } = await pick(6);
  const cases: [Record<string, unknown>, number][] = [
    [{ doctor_id: "nope", date: day }, 422],
    [{ doctor_id: doctorId, date: "2020-01-01" }, 503], // checked after the key: off means off
  ];
  for (const [data, status] of cases) {
    const res = await request.post(PATH, { data, headers: { origin: SITE } });
    expect(res.status()).toBe(status);
    expect(res.headers()["cache-control"]).toBe("no-store");
  }
});

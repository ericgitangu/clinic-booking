import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callApi } from "../src/call";
import {
  changeAccessRoleInternalAdminAccessEmailPatch,
  getMetricsInternalAdminMetricsGet,
  listDoctorsDoctorsGet,
} from "../src/generated";

const KEY = "k".repeat(32);
const caller = { sub: "sub-1", email: "owner@clinic.example", role: "owner" };

type Claims = { m: string; p: string; bh: string; role: string; email: string };

function claimsOf(header: string): Claims {
  const [version, payload] = header.split(".");
  expect(version).toBe("v1");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

const metrics = {
  range: { from: "2026-10-01", to: "2026-10-08" },
  bucket: "day",
  series: [],
  totals: { booked: 0, rescheduled: 0, cancelled: 0, upcoming_active: 0 },
  per_doctor: [],
};

let sent: Request[] = [];

beforeEach(() => {
  process.env.API_URL = "https://api.example.run.app";
  process.env.INTERNAL_SIGNING_KEY = KEY;
  delete process.env.VERCEL_ENV;
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push(new Request(input as Request, init));
    return Response.json(metrics);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("callApi signs the request it sends", () => {
  it("binds the assertion to the method, the path with its query and the empty body", async () => {
    const res = await callApi(
      "metrics",
      (client) =>
        getMetricsInternalAdminMetricsGet({
          client,
          query: { from: "2026-10-01", to: "2026-10-08", bucket: "day" },
        }),
      { caller },
    );
    expect(res.ok).toBe(true);
    const req = sent[0];
    const url = new URL(req.url);
    const claims = claimsOf(req.headers.get("X-Internal-Assertion") ?? "");
    expect(claims.m).toBe("GET");
    expect(claims.p).toBe(url.pathname + url.search);
    expect(claims.p).toBe(
      "/internal/admin/metrics?from=2026-10-01&to=2026-10-08&bucket=day",
    );
    expect(claims.bh).toBe(createHash("sha256").update("").digest("hex"));
    expect(claims.role).toBe("owner");
  });

  it("hashes the exact body bytes of a write and keeps an encoded email path as sent", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      sent.push(new Request(input as Request, init));
      return Response.json({
        email: "a@clinic.example",
        role: "admin",
        granted_by: "owner@clinic.example",
        granted_at: null,
        revoked_at: null,
        source: "db",
      });
    });
    await callApi(
      "changeAccessRole",
      (client) =>
        changeAccessRoleInternalAdminAccessEmailPatch({
          client,
          path: { email: "a@clinic.example" },
          body: { role: "admin" },
        }),
      { caller },
    );
    const req = sent[0];
    const body = await req.clone().text();
    const claims = claimsOf(req.headers.get("X-Internal-Assertion") ?? "");
    expect(claims.m).toBe("PATCH");
    expect(claims.p).toBe("/internal/admin/access/a%40clinic.example");
    expect(claims.bh).toBe(createHash("sha256").update(body).digest("hex"));
    expect(body).toBe('{"role":"admin"}');
  });

  it("sends no assertion on a public call", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      sent.push(new Request(input as Request, init));
      return Response.json({ items: [] });
    });
    await callApi("listDoctors", (client) => listDoctorsDoctorsGet({ client }));
    expect(sent[0].headers.get("X-Internal-Assertion")).toBeNull();
  });

  it("fails closed, sending nothing, when there is a caller but no signing key", async () => {
    delete process.env.INTERNAL_SIGNING_KEY;
    const res = await callApi(
      "metrics",
      (client) =>
        getMetricsInternalAdminMetricsGet({
          client,
          query: { from: "2026-10-01", to: "2026-10-08" },
        }),
      { caller },
    );
    expect(res).toMatchObject({
      ok: false,
      kind: "unavailable",
      code: "SIGNING_KEY_NOT_SET",
    });
    expect(sent).toEqual([]);
  });

  it("rejects an admin response that does not match the generated schema", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ ...metrics, totals: { booked: "many" } }),
    );
    const res = await callApi(
      "metrics",
      (client) =>
        getMetricsInternalAdminMetricsGet({
          client,
          query: { from: "2026-10-01", to: "2026-10-08" },
        }),
      { caller },
    );
    expect(res).toMatchObject({ ok: false, kind: "contract_violation" });
  });
});

describe("callApi keeps what a 429 says about waiting", () => {
  it("returns the Retry-After seconds with the problem", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          type: "https://api.example.run.app/problems/rate-limited",
          title: "Rate limited",
          status: 429,
          detail: "At most 60 changes every 10 minutes. Wait and try again.",
          instance: "/internal/admin/access/x@y.io",
          code: "RATE_LIMITED",
          request_id: "00000000-0000-4000-8000-000000000000",
        },
        { status: 429, headers: { "Retry-After": "42" } },
      ),
    );
    const res = await callApi(
      "changeRole",
      (client) =>
        changeAccessRoleInternalAdminAccessEmailPatch({
          client,
          path: { email: "x@y.io" },
          body: { role: "viewer" },
        }),
      { caller },
    );
    expect(res).toMatchObject({
      ok: false,
      kind: "problem",
      status: 429,
      code: "RATE_LIMITED",
      retryAfter: 42,
    });
  });

  it("leaves it out when the header is missing or not a whole number", async () => {
    for (const header of [undefined, "soon", "-3"]) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json(
          {
            type: "t",
            title: "Rate limited",
            status: 429,
            detail: "d",
            instance: "/i",
            code: "RATE_LIMITED",
            request_id: "00000000-0000-4000-8000-000000000000",
          },
          { status: 429, headers: header ? { "Retry-After": header } : {} },
        ),
      );
      const res = await callApi(
        "changeRole",
        (client) =>
          changeAccessRoleInternalAdminAccessEmailPatch({
            client,
            path: { email: "x@y.io" },
            body: { role: "viewer" },
          }),
        { caller },
      );
      expect(res.ok).toBe(false);
      expect("retryAfter" in res).toBe(false);
    }
  });
});

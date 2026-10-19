import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type Check,
  type JsonSchema,
  type PmCollection,
  WRITE_STEPS,
  assertionFor,
  computable,
  extractChecks,
  plan,
  run,
  signature,
  validate,
  variablesOf,
} from "@/lib/api-checks";

// The committed collection newman runs: the panel loads this same file.
const collection = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/api/clinic-booking.postman_collection.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PmCollection;

function checks(): Check[] {
  const r = extractChecks(collection);
  if (!r.ok) throw new Error(r.error);
  return r.checks;
}

describe("the collection, as the panel reads it", () => {
  it("every request has a status, and every problem a code", () => {
    const all = checks();
    expect(all.length).toBeGreaterThan(30);
    for (const c of all) {
      expect(c.status, c.name).toBeGreaterThanOrEqual(200);
      if (c.status >= 400 && c.status !== 404)
        expect(c.code, c.name).toMatch(/^[A-Z_]+$/);
      expect(c.schema, c.name).not.toBeNull();
    }
  });

  // These fail when the collection changes in a way the panel cannot follow: an assertion with no
  // runner here, a pre-request value this file cannot compute, or a write step that no longer exists.
  for (const mode of ["read", "write"] as const) {
    it(`the ${mode} plan can run every assertion the collection makes`, () => {
      for (const c of plan(checks(), mode)) {
        for (const t of c.tests)
          expect(assertionFor(t), `${c.name}: "${t}"`).not.toBeNull();
        expect(computable(c), c.name).toEqual(c.sets);
      }
    });
  }

  it("every write step matches exactly the request it names", () => {
    const writes = plan(checks(), "write").filter((c) => c.method !== "GET");
    const sigs = writes.map(signature);
    for (const step of WRITE_STEPS) expect(sigs, step).toContain(step);
    // Two patients, one booking and its replay, the double booking, too soon, the cancel.
    expect(writes.map((c) => `${c.method} ${c.status}`)).toEqual([
      "POST 201",
      "POST 201",
      "POST 201",
      "POST 201",
      "POST 409",
      "POST 422",
      "PATCH 200",
    ]);
    expect(writes.find((c) => c.code === "BOOKING_TOO_SOON")).toBeDefined();
    expect(writes.find((c) => c.code === "SLOT_TAKEN")).toBeDefined();
  });

  it("the read plan is the collection's GET requests that need no write", () => {
    const all = checks();
    const read = plan(all, "read");
    expect(read.every((c) => c.method === "GET")).toBe(true);
    const gets = all.filter((c) => c.method === "GET");
    const left = gets.filter((c) => !read.includes(c)).map(variablesOf);
    // Only the reads of what a write made are left out.
    for (const vars of left)
      expect(vars.some((v) => ["appointmentId", "patientId"].includes(v))).toBe(
        true,
      );
  });

  it("no planned body carries an email address or a phone number", () => {
    for (const c of plan(checks(), "write")) {
      expect(c.body ?? "", c.name).not.toMatch(/"(email|phone)"/);
    }
  });

  it("the requests a page cannot set up stay out of both plans", () => {
    const write = plan(checks(), "write");
    expect(write.some((c) => c.code === "CHANGE_TOO_LATE")).toBe(false);
    expect(write.some((c) => c.path.endsWith("/reschedule"))).toBe(false);
  });

  it("knows every schema keyword the collection uses", () => {
    const known = new Set([
      "type",
      "properties",
      "required",
      "items",
      "enum",
      "const",
      "pattern",
      "anyOf",
    ]);
    const seen = new Set<string>();
    const walk = (s: unknown, names = false): void => {
      if (Array.isArray(s)) return s.forEach((x) => walk(x));
      if (s === null || typeof s !== "object") return;
      for (const [k, v] of Object.entries(s)) {
        if (!names) seen.add(k);
        walk(v, k === "properties" && !names);
      }
    };
    for (const c of checks()) walk(c.schema);
    expect([...seen].filter((k) => !known.has(k))).toEqual([]);
  });
});

describe("validate", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      status: { enum: ["booked", "cancelled"] },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      tags: { type: "array", items: { type: "integer" } },
    },
  };
  const id = "0b9a2f4c-1111-4222-8333-444455556666";
  it("accepts a body that fits", () => {
    expect(
      validate(schema, { id, status: "booked", note: null, tags: [1] }),
    ).toBeNull();
  });
  it("names the first field that does not", () => {
    expect(validate(schema, { status: "booked" })).toBe("body.id is missing");
    expect(validate(schema, { id, status: "lost" })).toMatch(/body.status/);
    expect(validate(schema, { id, status: "booked", note: 3 })).toMatch(
      /body.note/,
    );
    expect(validate(schema, { id, status: "booked", tags: [1.5] })).toBe(
      "body.tags[0] is not integer",
    );
  });
});

// A stand-in for /api: answers from a table, and records what was sent.
function fakeApi(answer: (method: string, url: string) => [number, unknown]) {
  const sent: { method: string; url: string; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    sent.push({ method, url, body: init.body as string | undefined });
    const [status, body] = answer(method, url);
    const problem = status >= 400;
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": problem
          ? "application/problem+json"
          : "application/json",
      },
    });
  });
  return { sent, fetch: fetchImpl as unknown as typeof fetch };
}

describe("run", () => {
  it("a read-only run sends only GET requests, to /api", async () => {
    const api = fakeApi(() => [503, { code: "DOWN" }]);
    const out = await run(checks(), {
      mode: "read",
      base: "/api",
      fetch: api.fetch,
    });
    expect(out.length).toBe(plan(checks(), "read").length);
    expect(api.sent.length).toBeGreaterThan(0);
    expect(api.sent.every((r) => r.method === "GET")).toBe(true);
    expect(api.sent.every((r) => r.url.startsWith("/api/"))).toBe(true);
    // Nothing answered as the contract says, so nothing passes; the steps that need a doctor skip.
    expect(out.some((o) => o.state === "pass")).toBe(false);
    expect(out.filter((o) => o.state === "skip").length).toBeGreaterThan(0);
  });

  it("reports the status and the assertion that failed", async () => {
    const api = fakeApi((_, url) =>
      url === "/api/health" ? [200, { status: "degraded" }] : [503, {}],
    );
    const out = await run(checks(), {
      mode: "read",
      base: "/api",
      fetch: api.fetch,
    });
    const health = out.find((o) => o.check.path === "/health");
    expect(health?.state).toBe("fail");
    expect(health?.got).toBe(200);
    expect(health?.assertions.find((a) => a.error)?.name).toBe(
      "body matches the contract schema",
    );
  });

  it("cancels a booking the run would otherwise leave booked", async () => {
    const appt = "0b9a2f4c-1111-4222-8333-444455556666";
    const doctor = "1c9a2f4c-1111-4222-8333-444455556666";
    const day = (n: number) =>
      new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const api = fakeApi((method, url) => {
      if (url === "/api/doctors") return [200, { items: [{ id: doctor }] }];
      if (url.startsWith(`/api/doctors/${doctor}/availability?date=${day(1)}`))
        return [
          200,
          {
            date: day(1),
            slot_minutes: 30,
            slots: [
              { starts_at: `${day(1)}T06:00:00Z` },
              { starts_at: `${day(1)}T06:30:00Z` },
            ],
          },
        ];
      if (method === "POST" && url === "/api/patients")
        return [201, { id: crypto.randomUUID() }];
      if (method === "POST" && url === "/api/appointments")
        return [201, { id: appt, status: "booked" }];
      if (url === `/api/appointments/${appt}/cancel`)
        return [500, { code: "BROKEN" }];
      return [404, {}];
    });
    const out = await run(checks(), {
      mode: "write",
      base: "/api",
      fetch: api.fetch,
    });
    const cleanup = out.filter((o) => o.check.folder === "Clean-up");
    expect(cleanup).toHaveLength(1);
    expect(api.sent.filter((r) => r.url.endsWith("/cancel")).length).toBe(2);
    expect(
      api.sent
        .filter((r) => r.method !== "GET")
        .every((r) => !/"(email|phone)"/.test(r.body ?? "")),
    ).toBe(true);
  });
});

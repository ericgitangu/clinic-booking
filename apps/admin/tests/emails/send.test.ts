import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDemoRecipient,
  sendStaffEmail,
  staffBooked,
  STAFF_FROM,
  type StaffEmailInput,
} from "@/emails";
import { ASSERTION_HEADER } from "@clinic/api/assertion";
import { defaultPorts } from "@/emails/ports";

// Two real local HTTP servers on free ports: one plays Resend, one plays the clinic API's three
// calls (reserve, release, notified). The code under test is the real sendStaffEmail with its real
// default wiring (signed API calls, the shared sender), so what is observed here is what the admin
// server action would do.
interface Hit {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const AUDIT = "7b0c1a52-3f0e-4c0e-9d57-0b6f1c2f8a11";
const TO = "mwangi.kamau@mail.test";
const TOKEN_LIKE = "SeCrEt-TOKEN-0123456789";

let resend: Server;
let api: Server;
let resendHits: Hit[];
let apiHits: Hit[];
let resendStatus: number;
let cap: "none" | "day" | "month";
let apiDown: boolean;

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: Server; port: number }>((ok) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      ok({ server, port: (server.address() as { port: number }).port }),
    );
  });

const read = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b));
  });

const budget = {
  daily_limit: 90,
  day: "2026-10-18",
  month: "2026-10-01",
  month_sent: 10,
  monthly_limit: 2500,
  remaining: 80,
  sent: 10,
};

beforeEach(async () => {
  resendHits = [];
  apiHits = [];
  resendStatus = 200;
  cap = "none";
  apiDown = false;

  const r = await listen(async (req, res) => {
    resendHits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: await read(req),
    });
    res.writeHead(resendStatus, { "content-type": "application/json" });
    res.end(
      resendStatus === 200
        ? JSON.stringify({ id: "resend-id-1" })
        : JSON.stringify({
            name: "validation_error",
            message: `bad address ${TO}`,
          }),
    );
  });
  resend = r.server;

  const a = await listen(async (req, res) => {
    const hit = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: await read(req),
    };
    apiHits.push(hit);
    if (apiDown) return res.destroy();
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (hit.url === "/internal/emails/reserve")
      return json(200, {
        granted: cap === "none",
        reason: cap === "none" ? null : cap,
        day: "2026-10-18",
        month: "2026-10-01",
        budget,
      });
    if (hit.url === "/internal/emails/release") return json(200, budget);
    const m = /^\/internal\/admin\/audit\/([^/]+)\/notified$/.exec(hit.url);
    if (m) return json(200, { audit_id: m[1], notified: true });
    return json(404, {});
  });
  api = a.server;

  vi.stubEnv("RESEND_API_KEY", ["re", "test", "key", "0123456789"].join("_")); // ggignore
  vi.stubEnv("RESEND_BASE_URL", `http://127.0.0.1:${r.port}`);
  vi.stubEnv("API_URL", `http://127.0.0.1:${a.port}`);
  vi.stubEnv("INTERNAL_SIGNING_KEY", "k".repeat(40));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of [resend, api]) {
    s.closeAllConnections();
    await new Promise((ok) => s.close(ok));
  }
});

const caller = {
  sub: "staff-1",
  email: "staff@clinic.test",
  role: "admin",
  emailVerified: true,
};

const mail = () =>
  staffBooked({
    name: "Mwangi Kamau",
    doctor: "Dr. Achieng Otieno",
    startsAt: "2026-10-20T09:00:00+03:00",
    reason: "Booked at your request by phone.",
  });

const input = (over: Partial<StaffEmailInput> = {}): StaffEmailInput => ({
  caller,
  auditId: AUDIT,
  to: TO,
  deliver: true,
  mail: mail(),
  ...over,
});

const logs = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("sendStaffEmail: the sending path", () => {
  it("reserves, sends once with Idempotency-Key = audit id, then marks notified", async () => {
    const r = await sendStaffEmail(input());
    expect(r).toEqual({
      auditId: AUDIT,
      outcome: "sent",
      sent: true,
      notified: true,
    });
    expect(resendHits).toHaveLength(1);
    const hit = resendHits[0]!;
    expect(hit.url).toBe("/emails");
    expect(hit.headers["idempotency-key"]).toBe(AUDIT);
    const body = JSON.parse(hit.body);
    expect(body.to).toBe(TO);
    expect(body.subject).toBe(mail().subject);
    expect(body.html).toBe(mail().html);
    expect(body.reply_to).toBe("developer.ericgitangu@gmail.com");
    expect(apiHits.map((h) => `${h.method} ${h.url}`)).toEqual([
      "POST /internal/emails/reserve",
      `POST /internal/admin/audit/${AUDIT}/notified`,
    ]);
    // the API calls are signed as the staff member
    for (const h of apiHits)
      expect(h.headers[ASSERTION_HEADER.toLowerCase()]).toBeTruthy();
  });

  it("sends from the literal display name 'Idyllic Clinic' on the verified subdomain", async () => {
    expect(STAFF_FROM).toBe("Idyllic Clinic <reminders@mail.ericgitangu.com>");
    await sendStaffEmail(input());
    expect(JSON.parse(resendHits[0]!.body).from).toBe(
      "Idyllic Clinic <reminders@mail.ericgitangu.com>",
    );
  });

  it("a Resend refusal sends nothing more: the reservation is given back and notified is not called", async () => {
    resendStatus = 400;
    const r = await sendStaffEmail(input());
    expect(r).toMatchObject({
      outcome: "send-failed",
      sent: false,
      notified: false,
    });
    expect(apiHits.map((h) => h.url)).toEqual([
      "/internal/emails/reserve",
      "/internal/emails/release",
    ]);
  });

  it("gives up on a Resend that never answers, inside the 5 s bound", async () => {
    resend.closeAllConnections();
    await new Promise((ok) => resend.close(ok));
    const hang = await listen(() => {});
    vi.stubEnv("RESEND_BASE_URL", `http://127.0.0.1:${hang.port}`);
    const t0 = Date.now();
    const r = await sendStaffEmail(
      input(),
      // the real wiring with a short bound, to keep the test fast; the default is SEND_TIMEOUT_MS (5 s)
      {
        ...defaultPorts,
        send: (to, m, k) =>
          import("@clinic/api/mail").then((x) =>
            x.sendMail(
              { from: STAFF_FROM, replyTo: "r@x.test" },
              to,
              m,
              k,
              300,
            ),
          ),
      },
    );
    hang.server.closeAllConnections();
    await new Promise((ok) => hang.server.close(ok));
    expect(r.outcome).toBe("send-failed");
    expect(Date.now() - t0).toBeLessThan(2000);
    // restore a closed server for afterEach
    resend = (await listen(() => {})).server;
  });

  it("the shared sender's bound is 5 s", async () => {
    const { SEND_TIMEOUT_MS } = await import("@clinic/api/mail");
    expect(SEND_TIMEOUT_MS).toBe(5_000);
  });
});

describe("sendStaffEmail: what never reaches the sender", () => {
  it("deliver:false is not sent, reserved or marked", async () => {
    const r = await sendStaffEmail(input({ deliver: false }));
    expect(r).toMatchObject({
      outcome: "not-deliverable",
      sent: false,
      notified: false,
    });
    expect(resendHits).toHaveLength(0);
    expect(apiHits).toHaveLength(0);
  });

  it.each(["someone@example.com", "Someone@EXAMPLE.ORG", "  a.b@example.net "])(
    "a demo recipient (%s) never reaches Resend, even with deliver:true",
    async (to) => {
      expect(isDemoRecipient(to)).toBe(true);
      const r = await sendStaffEmail(input({ to, deliver: true }));
      expect(r).toMatchObject({
        outcome: "demo-recipient",
        sent: false,
        notified: false,
      });
      expect(resendHits).toHaveLength(0);
      expect(apiHits).toHaveLength(0);
    },
  );

  it("a real-looking domain that merely contains 'example' is not a demo recipient", () => {
    expect(isDemoRecipient("a@notexample.com")).toBe(false);
    expect(isDemoRecipient("a@example.com.evil.test")).toBe(false);
    expect(isDemoRecipient("a@mail.test")).toBe(false);
  });

  it.each([null, undefined, "", "   "])(
    "no address on file (%j) is not sent",
    async (to) => {
      const r = await sendStaffEmail(input({ to }));
      expect(r.outcome).toBe("no-recipient");
      expect(resendHits).toHaveLength(0);
      expect(apiHits).toHaveLength(0);
    },
  );

  it("without RESEND_API_KEY nothing is sent and nothing is reserved", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    logs();
    const r = await sendStaffEmail(input());
    expect(r.outcome).toBe("not-configured");
    expect(resendHits).toHaveLength(0);
    expect(apiHits).toHaveLength(0);
  });
});

describe("sendStaffEmail: the allowance", () => {
  it.each(["day", "month"] as const)(
    "when the %s's cap is hit nothing is sent and notified is not called",
    async (which) => {
      cap = which;
      const spy = logs();
      const r = await sendStaffEmail(input());
      expect(r).toEqual({
        auditId: AUDIT,
        outcome: "cap-hit",
        sent: false,
        notified: false,
      });
      expect(resendHits).toHaveLength(0);
      expect(apiHits.map((h) => h.url)).toEqual(["/internal/emails/reserve"]);
      expect(spy).toHaveBeenCalled();
    },
  );

  it("fails closed when the allowance cannot be reserved", async () => {
    apiDown = true;
    logs();
    const r = await sendStaffEmail(input());
    expect(r.outcome).toBe("reserve-failed");
    expect(resendHits).toHaveLength(0);
  });
});

describe("sendStaffEmail: never throws, never logs personal data", () => {
  it("returns a typed result when a port throws", async () => {
    logs();
    const r = await sendStaffEmail(input(), {
      ...defaultPorts,
      reserve: () => Promise.reject(new Error(`boom ${TO}`)),
    });
    expect(r).toMatchObject({ outcome: "error", sent: false, notified: false });
  });

  it("a send that succeeded but could not be marked still reports sent", async () => {
    logs();
    const r = await sendStaffEmail(input(), {
      ...defaultPorts,
      markNotified: () =>
        Promise.resolve({ ok: false, code: "UPSTREAM_UNREACHABLE" }),
    });
    expect(r).toMatchObject({ outcome: "sent", sent: true, notified: false });
  });

  it("logs ids and outcomes only: no address, name, reason or token, on any path", async () => {
    const spy = logs();
    const withToken = {
      ...mail(),
      html: `${mail().html}/invite/${TOKEN_LIKE}`,
    };
    resendStatus = 400; // Resend's refusal message echoes the address; it must come out redacted
    await sendStaffEmail(input({ mail: withToken }));
    cap = "day";
    await sendStaffEmail(input({ mail: withToken }));
    cap = "none";
    apiDown = true;
    await sendStaffEmail(input({ mail: withToken }));
    await sendStaffEmail(input({ mail: withToken }), {
      ...defaultPorts,
      reserve: () => Promise.reject(new Error(`boom ${TO} ${TOKEN_LIKE}`)),
    });
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).not.toBe("");
    expect(out).toContain(AUDIT);
    for (const secret of [
      TO,
      "mwangi",
      "Mwangi",
      "Kamau",
      TOKEN_LIKE,
      "Booked at your request",
      "re_test_key",
    ])
      expect(out).not.toContain(secret);
  });
});

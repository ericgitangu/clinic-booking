import { afterEach, describe, expect, it, vi } from "vitest";
import { ackKey } from "@/lib/email/acknowledge";
import { compose } from "@/lib/email/compose";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FROM, MAIL_DOMAIN, REPLY_TO } from "@/lib/email/sender";
import { sendEmail } from "@/lib/email/send";
import { RUN_LIMIT, reminderKey } from "@/lib/email/reminders";
import { GET } from "@/app/cron/reminders/route";

const base = {
  name: "Amina Wanjiku",
  doctor: "Dr. Achieng Otieno",
  specialty: "General Practice",
  startsAt: "2026-10-20T09:00:00+03:00",
  timezone: "Africa/Nairobi",
};

describe("the Idyllic emails", () => {
  it.each([
    [
      "booked",
      "Your appointment is booked: Tuesday 20 October, 09:00",
      "You are booked",
    ],
    [
      "rescheduled",
      "Your appointment was moved to Tuesday 20 October, 09:00",
      "Your appointment was moved",
    ],
    [
      "cancelled",
      "Your appointment on Tuesday 20 October, 09:00 was cancelled",
      "Your appointment was cancelled",
    ],
    [
      "reminder",
      "Reminder: your appointment tomorrow, Tuesday 20 October, 09:00",
      "Your appointment is tomorrow",
    ],
  ] as const)(
    "%s has a plain subject, HTML and a text version with the details",
    async (kind, subject, heading) => {
      const mail = await compose({ kind, ...base });
      expect(mail.subject).toBe(subject);
      expect(mail.html).toContain(heading);
      // the plain-text renderer writes headings in capitals
      expect(mail.text.toLowerCase()).toContain(heading.toLowerCase());
      for (const part of [mail.html, mail.text]) {
        expect(part).toContain("Dr. Achieng Otieno");
        expect(part).toContain("General Practice");
        expect(part).toContain("09:00");
        expect(part).not.toContain("undefined");
      }
      expect(mail.text).not.toMatch(/<[a-z][^>]*>/i);
      expect(mail.html).toContain("https://clinic.ericgitangu.com/privacy");
    },
  );

  it("shows the old time on a moved appointment and the reason on a cancelled one", async () => {
    const moved = await compose({
      kind: "rescheduled",
      ...base,
      previousStartsAt: "2026-10-19T11:30:00+03:00",
    });
    expect(moved.text).toContain("Was: Monday 19 October, 11:30");
    const cancelled = await compose({
      kind: "cancelled",
      ...base,
      reason: "Plans changed",
    });
    expect(cancelled.text).toContain("Plans changed");
    const plain = await compose({ kind: "booked", ...base });
    expect(plain.text).not.toContain("Was:");
    expect(plain.text).not.toContain("reason");
  });

  it("shows the time in the clinic's own zone and names it, never a fixed Nairobi time", async () => {
    // 07:00 UTC on Monday 26 October is 08:00 in Berlin (CET, +01:00), 10:00 in Nairobi.
    const berlin = {
      ...base,
      startsAt: "2026-10-26T08:00:00+01:00",
      timezone: "Europe/Berlin",
    };
    const mail = await compose({ kind: "booked", ...berlin });
    expect(mail.subject).toBe(
      "Your appointment is booked: Monday 26 October, 08:00",
    );
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("Central European Standard Time (GMT+01:00)");
      expect(part).not.toContain("Nairobi");
      expect(part).not.toContain("East Africa");
    }
    // The same instant for the Nairobi clinic reads 10:00 and is named East Africa Time.
    const nairobi = await compose({
      kind: "booked",
      ...base,
      startsAt: "2026-10-26T08:00:00+01:00",
    });
    expect(nairobi.subject).toBe(
      "Your appointment is booked: Monday 26 October, 10:00",
    );
    expect(nairobi.text).toContain("East Africa Time (GMT+03:00)");
    // A moved appointment shows the old time in the same zone.
    const moved = await compose({
      kind: "rescheduled",
      ...berlin,
      previousStartsAt: "2026-10-26T09:30:00+01:00",
    });
    expect(moved.text).toContain("Was: Monday 26 October, 09:30");
  });

  it("escapes what a person typed in the HTML and keeps it readable in the text", async () => {
    const mail = await compose({
      kind: "booked",
      ...base,
      name: "<script>alert(1)</script> & Co",
    });
    expect(mail.html).not.toContain("<script>alert(1)</script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).toContain("<script>alert(1)</script> & Co");
  });

  it("links to the right place for each kind", async () => {
    expect((await compose({ kind: "booked", ...base })).html).toContain(
      'href="https://clinic.ericgitangu.com/appointments"',
    );
    expect((await compose({ kind: "cancelled", ...base })).html).toContain(
      'href="https://clinic.ericgitangu.com/book"',
    );
  });
});

describe("idempotency keys", () => {
  const appt = {
    id: "11111111-1111-4111-8111-111111111111",
    updated_at: "2026-10-19T04:00:00.123Z",
  };
  it("an acknowledgement key is one per change, stable for a repeat and new for the next change", () => {
    const k = ackKey("booked", appt);
    expect(k).toBe(`ack/${appt.id}/booked/${Date.parse(appt.updated_at)}`);
    expect(ackKey("booked", appt)).toBe(k);
    expect(
      ackKey("booked", { ...appt, updated_at: "2026-10-19T04:05:00.000Z" }),
    ).not.toBe(k);
    expect(ackKey("cancelled", appt)).not.toBe(k);
    expect(k.length).toBeLessThanOrEqual(256);
  });
  it("a reminder key names the appointment and its start time, so a moved time gets a new one", () => {
    const a = reminderKey(appt.id, "2026-10-20T09:00:00+03:00");
    expect(a).toBe(
      `reminder/${appt.id}/${Math.floor(Date.parse("2026-10-20T09:00:00+03:00") / 1000)}`,
    );
    expect(reminderKey(appt.id, "2026-10-20T11:00:00+03:00")).not.toBe(a);
    expect(reminderKey(appt.id, "2026-10-20T06:00:00Z")).toBe(a); // the same instant, written another way
  });
  it("a run is capped at 50", () => expect(RUN_LIMIT).toBe(50));
});

describe("sending", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("sends from the verified subdomain with the engineer as reply-to", () => {
    expect(MAIL_DOMAIN).toBe("mail.ericgitangu.com"); // the domain verified in Resend
    expect(FROM).toBe("Idyllic Clinic <reminders@mail.ericgitangu.com>");
    expect(REPLY_TO).toBe("developer.ericgitangu@gmail.com");
  });
  it("the sender's domain is the one configured domain, so the two cannot drift", () => {
    const domain = /<[^@>]+@([^>]+)>$/.exec(FROM)?.[1];
    expect(domain).toBe(MAIL_DOMAIN);
  });
  it("no file in the repository, README included, names the root domain as the sender", () => {
    // The old sender, built from parts so this file does not contain it. Resend rejects a send from
    // a domain it has not verified, and only the subdomain is verified.
    const old = ["reminders", "@", "ericgitangu", ".com"].join("");
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const files = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(
        (f) =>
          f !== "" &&
          // The decision records say what was sent before (history). The folder goes away with the
          // history rewrite; drop this line then. Path built from parts: no file names that folder.
          !f.startsWith(["docs", "adr", ""].join("/")) &&
          // Lockfiles and binaries carry nothing to check
          !/\.(png|webp|ico|jpg|svg|woff2?|lock|yaml)$/.test(f) &&
          f !== "pnpm-lock.yaml",
      );
    const hits = files.filter((f) => {
      try {
        return readFileSync(`${root}/${f}`, "utf8").includes(old);
      } catch {
        return false; // listed but not on disk (deleted in the working tree)
      }
    });
    expect(hits).toEqual([]);
  });
  it("gives up on a Resend that accepts the request and never answers", async () => {
    // A real local HTTP server that accepts the connection and the request and never replies.
    const { createServer } = await import("node:http");
    let received = 0;
    const hang = createServer(() => {
      received++;
    });
    await new Promise<void>((ok) => hang.listen(0, "127.0.0.1", ok));
    const port = (hang.address() as { port: number }).port;
    vi.stubEnv("RESEND_API_KEY", "x".repeat(20));
    vi.stubEnv("RESEND_BASE_URL", `http://127.0.0.1:${port}`);
    const t0 = Date.now();
    const r = await sendEmail(
      "a@x.test",
      { subject: "s", html: "<p>h</p>", text: "t" },
      "k/1",
      300,
    );
    const took = Date.now() - t0;
    hang.closeAllConnections();
    await new Promise((ok) => hang.close(ok));
    expect(r).toEqual({ ok: false, reason: "timed-out" });
    expect(received).toBe(1); // the request really reached it
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
  });
  it("logs why Resend refused: status, name and the message with addresses redacted and cut at 200", async () => {
    // A real local HTTP server (any free port) that answers like Resend does for a bad request.
    const { createServer } = await import("node:http");
    const long = "x".repeat(300);
    const hit = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          statusCode: 400,
          name: "validation_error",
          message: `Invalid \`to\` field: pat.person@example.test is not allowed, cc bob+tag@mail.example.test. ${long}`,
        }),
      );
    });
    await new Promise<void>((ok) => hit.listen(0, "127.0.0.1", ok));
    const port = (hit.address() as { port: number }).port;
    const apiKey = ["re", "unit", "test", "key", "0123456789"].join("_"); // ggignore
    vi.stubEnv("RESEND_API_KEY", apiKey);
    vi.stubEnv("RESEND_BASE_URL", `http://127.0.0.1:${port}`);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const r = await sendEmail(
      "pat.person@example.test",
      {
        subject: "Secret subject",
        html: "<p>Secret body</p>",
        text: "Secret body",
      },
      "ack/1",
    );
    await new Promise((ok) => hit.close(ok));
    expect(r).toEqual({ ok: false, reason: "rejected", status: 400 });
    const line = String(errors.mock.calls[0][0]);
    const logged = JSON.parse(line) as Record<string, unknown>;
    expect(logged).toMatchObject({
      message: "email rejected",
      status: 400,
      name: "validation_error",
      key: "ack",
    });
    const why = String(logged.detail ?? "");
    expect(why).toContain(
      "Invalid `to` field: <redacted> is not allowed, cc <redacted>.",
    );
    expect(why.length).toBeLessThanOrEqual(200);
    expect(line).not.toContain("example.test");
    expect(line).not.toContain(apiKey);
    expect(line).not.toContain("Secret");
  });
  it("without a key it reports not configured and makes no request", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await sendEmail(
      "a@x.test",
      { subject: "s", html: "<p>h</p>", text: "t" },
      "k/1",
    );
    expect(r).toEqual({ ok: false, reason: "not-configured" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the reminder route", () => {
  afterEach(() => vi.unstubAllEnvs());
  const call = (headers: Record<string, string> = {}) =>
    GET(new Request("http://localhost/cron/reminders", { headers }));
  it("refuses a request with no secret configured, no header, or the wrong header", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(
      (await call({ authorization: "Bearer anything-at-all-long" })).status,
    ).toBe(401);
    vi.stubEnv("CRON_SECRET", "a-long-enough-secret-value");
    expect((await call()).status).toBe(401);
    expect(
      (await call({ authorization: "Bearer wrong-secret-value-here" })).status,
    ).toBe(401);
    expect(
      (await call({ authorization: "a-long-enough-secret-value" })).status,
    ).toBe(401);
  });
  it("refuses a secret that is too short to be one", async () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect((await call({ authorization: "Bearer short" })).status).toBe(401);
  });
});

describe("which failures are worth another try", () => {
  it("retries a busy or unreachable Resend and nothing else", async () => {
    const { retryable, BACKOFF_MS, RETRY_BUDGET } =
      await import("@/lib/email/reminders");
    expect(retryable({ ok: false, reason: "rejected", status: 500 })).toBe(
      true,
    );
    expect(retryable({ ok: false, reason: "rejected", status: 503 })).toBe(
      true,
    );
    expect(retryable({ ok: false, reason: "rejected", status: 429 })).toBe(
      true,
    );
    expect(retryable({ ok: false, reason: "unreachable" })).toBe(true);
    expect(retryable({ ok: false, reason: "timed-out" })).toBe(true);
    expect(retryable({ ok: false, reason: "rejected", status: 422 })).toBe(
      false,
    );
    expect(retryable({ ok: false, reason: "rejected", status: 401 })).toBe(
      false,
    );
    expect(retryable({ ok: false, reason: "not-configured" })).toBe(false);
    expect(retryable({ ok: true, id: "x" })).toBe(false);
    // bounded: two pauses per email and a budget for the whole run, well inside the function's limit
    expect(BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
    expect(RETRY_BUDGET).toBeLessThanOrEqual(30);
  });
});

describe("an acknowledgement when the allowance cannot be reserved", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("is dropped, not sent: a broken counter never becomes unlimited email", async () => {
    const { acknowledge } = await import("@/lib/email/acknowledge");
    // The API is unreachable (nothing listens on this port), so the budget lookup fails for real.
    vi.stubEnv("API_URL", "http://127.0.0.1:9");
    vi.stubEnv("INTERNAL_SIGNING_KEY", "k".repeat(32));
    vi.stubEnv("RESEND_API_KEY", "x".repeat(20));
    vi.stubEnv("RESEND_BASE_URL", "http://127.0.0.1:9");
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      urls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      );
      return realFetch(input, init);
    });
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await acknowledge(
      "booked",
      {
        id: "11111111-1111-4111-8111-111111111111",
        doctor_id: "22222222-2222-4222-8222-222222222222",
        patient_id: "33333333-3333-4333-8333-333333333333",
        starts_at: "2026-10-20T09:00:00+03:00",
        ends_at: "2026-10-20T09:30:00+03:00",
        status: "booked",
        timezone: "Africa/Nairobi",
        cancellation_reason: null,
        cancelled_at: null,
        locked: false,
        created_at: "2026-10-19T04:00:00Z",
        updated_at: "2026-10-19T04:00:00Z",
      },
      {
        caller: {
          sub: "s",
          email: "a@x.test",
          role: "patient",
          emailVerified: true,
        },
        who: { sub: "s", email: "a@x.test", name: "Pat Person" },
        doctor: { full_name: "Dr A", specialty: "GP" },
      },
    );
    expect(urls.some((u) => new URL(u).pathname === "/emails")).toBe(false); // nothing went to Resend
    expect(urls.some((u) => u.includes("/internal/emails/reserve"))).toBe(true); // the allowance was asked for
    expect(errors.mock.calls.join("\n")).toContain(
      "the allowance could not be reserved",
    );
  });
});

describe("without RESEND_API_KEY", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });
  it("sends nothing, calls nothing, says so once, and the reminder run claims nothing", async () => {
    vi.resetModules(); // a fresh module, so "once per server instance" starts from zero
    vi.stubEnv("RESEND_API_KEY", "");
    const fetched = vi.spyOn(globalThis, "fetch");
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { acknowledge } = await import("@/lib/email/acknowledge");
    const { runReminders } = await import("@/lib/email/reminders");
    const appt = {
      id: "11111111-1111-4111-8111-111111111111",
      doctor_id: "22222222-2222-4222-8222-222222222222",
      patient_id: "33333333-3333-4333-8333-333333333333",
      starts_at: "2026-10-20T09:00:00+03:00",
      ends_at: "2026-10-20T09:30:00+03:00",
      status: "booked" as const,
      timezone: "Africa/Nairobi",
      cancellation_reason: null,
      cancelled_at: null,
      locked: false,
      created_at: "2026-10-19T04:00:00Z",
      updated_at: "2026-10-19T04:00:00Z",
    };
    const ctx = {
      caller: {
        sub: "s",
        email: "a@x.test",
        role: "patient" as const,
        emailVerified: true,
      },
      who: { sub: "s", email: "a@x.test", name: "Pat Person" },
      doctor: null,
    };
    await acknowledge("booked", appt, ctx);
    await acknowledge("cancelled", appt, ctx);
    const run = await runReminders();
    expect(run).toMatchObject({ claimed: 0, sent: 0, error: "not-configured" });
    expect(fetched).not.toHaveBeenCalled();
    const lines = errors.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("RESEND_API_KEY is not set"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/re_/); // no key material in the line
  });
});

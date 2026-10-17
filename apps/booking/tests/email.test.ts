import { afterEach, describe, expect, it, vi } from "vitest";
import { ackKey } from "@/lib/email/acknowledge";
import { compose } from "@/lib/email/compose";
import { FROM, REPLY_TO, sendEmail } from "@/lib/email/send";
import { RUN_LIMIT, reminderKey } from "@/lib/email/reminders";
import { GET } from "@/app/cron/reminders/route";

const base = {
  name: "Amina Wanjiku",
  doctor: "Dr. Achieng Otieno",
  specialty: "General Practice",
  startsAt: "2026-10-20T09:00:00+03:00",
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
  it("sends from reminders@ericgitangu.com with the engineer as reply-to", () => {
    expect(FROM).toContain("<reminders@ericgitangu.com>");
    expect(REPLY_TO).toBe("developer.ericgitangu@gmail.com");
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

describe("an acknowledgement when the day's budget cannot be read", () => {
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
        cancellation_reason: null,
        cancelled_at: null,
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
    expect(urls.some((u) => u.includes("/internal/emails/today"))).toBe(true); // the budget was asked for
    expect(errors.mock.calls.join("\n")).toContain(
      "the day's limit could not be read",
    );
  });
});

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// On the wire: which `purpose` the patient app sends when it reserves one email from the shared
// allowance. A booking acknowledgement is "ack" (it may use the whole day); a reminder is "other"
// (it stops short of the room kept for acknowledgements). A fake API records the request and
// refuses the reservation, so nothing is sent and nothing else is needed.
let api: Server;
const seen: string[] = [];

const budget = {
  day: "2026-10-20",
  sent: 0,
  daily_limit: 100,
  month: "2026-10-01",
  month_sent: 0,
  monthly_limit: 3000,
  remaining: 0,
};

beforeEach(async () => {
  seen.length = 0;
  api = createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if ((req.url ?? "").startsWith("/internal/emails/reserve")) {
      seen.push(req.url ?? "");
      return json({
        granted: false,
        reason: "day",
        day: "2026-10-20",
        month: "2026-10-01",
        budget,
      });
    }
    if ((req.url ?? "").startsWith("/internal/reminders/claim"))
      return json({
        date: "2026-10-21",
        sent_today: 0,
        daily_limit: 100,
        items: [
          {
            appointment_id: "11111111-1111-4111-8111-111111111111",
            claimed_at: "2026-10-20T04:00:00Z",
            doctor_name: "Dr. A",
            patient_email: "p@clinic-e2e.org",
            patient_name: "Pat Person",
            specialty: "GP",
            starts_at: "2026-10-21T09:00:00+03:00",
            timezone: "Africa/Nairobi",
          },
        ],
      });
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
  vi.stubEnv(
    "API_URL",
    `http://127.0.0.1:${(api.address() as { port: number }).port}`,
  );
  vi.stubEnv("INTERNAL_SIGNING_KEY", "k".repeat(40));
  vi.stubEnv("RESEND_API_KEY", ["re", "test", "key", "0123456789"].join("_")); // ggignore
  vi.stubEnv("RESEND_BASE_URL", "http://127.0.0.1:9"); // a send would fail loudly
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  api.closeAllConnections();
  await new Promise((ok) => api.close(ok));
});

describe("the allowance purpose the patient app sends", () => {
  it("a booking acknowledgement reserves as ack", async () => {
    const { acknowledge } = await import("@/lib/email/acknowledge");
    await acknowledge(
      "booked",
      {
        id: "11111111-1111-4111-8111-111111111111",
        doctor_id: "22222222-2222-4222-8222-222222222222",
        patient_id: "33333333-3333-4333-8333-333333333333",
        starts_at: "2026-10-21T09:00:00+03:00",
        ends_at: "2026-10-21T09:30:00+03:00",
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
          email: "p@clinic-e2e.org",
          role: "patient",
          emailVerified: true,
        },
        who: { sub: "s", email: "p@clinic-e2e.org", name: "Pat Person" },
        doctor: null,
      },
    );
    expect(seen).toEqual(["/internal/emails/reserve?purpose=ack"]);
  });

  it("a reminder reserves as other", async () => {
    const { runReminders } = await import("@/lib/email/reminders");
    await runReminders();
    expect(seen).toEqual(["/internal/emails/reserve?purpose=other"]);
  });
});

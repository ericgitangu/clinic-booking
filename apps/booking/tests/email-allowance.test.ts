import { afterEach, describe, expect, it, vi } from "vitest";
import { withDb } from "../e2e/support/db";

// Against the real API and its Postgres (the e2e-real job and `make e2e` set REAL_API_URL and
// INTERNAL_SIGNING_KEY): with the month's allowance used up, an acknowledgement sends nothing, says
// so once, and cannot fail anything. Nothing is stood in. The counter is put at the cap straight in
// the database (a count no real run would reach) and removed again in `finally`; no other test
// sends email while this one runs (vitest runs before Playwright in `make e2e` and in CI).
describe.skipIf(!process.env.REAL_API_URL)(
  "with the month's email allowance used up",
  () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it("sends nothing, logs it once, and the caller is unaffected", async () => {
      process.env.API_URL = process.env.REAL_API_URL;
      vi.stubEnv("RESEND_API_KEY", "x".repeat(20));
      vi.stubEnv("RESEND_BASE_URL", "http://127.0.0.1:9"); // nothing listens: a send would be seen
      const fetched = vi.spyOn(globalThis, "fetch");
      const errors = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const { acknowledge } = await import("@/lib/email/acknowledge");
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
          sub: "allowance-test",
          email: "allowance@example.test",
          role: "patient" as const,
          emailVerified: true,
        },
        who: {
          sub: "allowance-test",
          email: "allowance@example.test",
          name: "Pat Person",
        },
        doctor: null,
      };
      await withDb((db) =>
        db.query(
          `INSERT INTO email_month_counter (month, sent)
           VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, 2000000000)
           ON CONFLICT (month) DO UPDATE SET sent = 2000000000`,
        ),
      );
      try {
        await acknowledge("booked", appt, ctx);
        await acknowledge("cancelled", appt, ctx);
      } finally {
        await withDb((db) =>
          db.query(
            `DELETE FROM email_month_counter
             WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
          ),
        );
      }
      const toResend = fetched.mock.calls.filter((c) =>
        String(c[0]).includes("127.0.0.1:9"),
      );
      expect(toResend).toHaveLength(0); // no send was even attempted
      const said = errors.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("limit is used up"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("month");
    });
  },
);

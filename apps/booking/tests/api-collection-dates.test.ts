import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clinicDayAhead,
  naiveStart,
  nightStart,
  offGridStart,
} from "../../../scripts/api_collection_dates.mjs";

// The clinic is Africa/Nairobi: UTC+3, no daylight saving. The API's lead time is 60 minutes and it
// checks the lead time before the grid and before working hours (validate_slot).
const LEAD_MS = 60 * 60000;
const DAY_MS = 86400000;
const OFFSET = "+03:00";

// Midnight at the start of a clinic date, as an instant.
const clinicMidnight = (day: string) => Date.parse(`${day}T00:00:00${OFFSET}`);
const clinicTodayStart = (nowMs: number) =>
  clinicMidnight(clinicDayAhead(nowMs, 0));

// 21:30 and 23:59 UTC are 00:30 and 02:59 the next day in Nairobi: the hours where the UTC
// "tomorrow" is the clinic's today. Midday is the control.
const NOWS = {
  "21:30 UTC": Date.parse("2026-10-20T21:30:00Z"),
  "23:59 UTC": Date.parse("2026-10-20T23:59:00Z"),
  "12:00 UTC (control)": Date.parse("2026-10-20T12:00:00Z"),
};

describe.each(Object.entries(NOWS))("collection dates at %s", (_label, now) => {
  it("counts the clinic's today, not the UTC date", () => {
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const expected =
      now >= Date.parse("2026-10-20T21:00:00Z") ? "2026-10-21" : utcDay;
    expect(clinicDayAhead(now, 0)).toBe(expected);
  });

  it("puts the night time at least two clinic days after the clinic's today, outside the lead time", () => {
    const t = Date.parse(nightStart(now, OFFSET));
    expect(t).toBeGreaterThanOrEqual(clinicTodayStart(now) + 2 * DAY_MS);
    // so it is past the lead check and reaches the working-hours check
    expect(t - now).toBeGreaterThan(LEAD_MS);
    // and it is 03:00 on the clinic clock, never a working hour
    expect(nightStart(now, OFFSET)).toMatch(/T03:00:00\+03:00$/);
  });

  it("keeps the off-grid and no-offset times past the lead time when built from the earliest legal slot", () => {
    // The earliest slot the API can list is exactly the lead time away.
    const slot = new Date(now + LEAD_MS).toISOString();
    expect(Date.parse(offGridStart(slot)) - now).toBeGreaterThan(LEAD_MS);
    expect(new Date(offGridStart(slot)).getTime() % (30 * 60000)).not.toBe(0);
    expect(naiveStart(`2026-10-22T10:00:00${OFFSET}`)).toBe(
      "2026-10-22T10:00:00",
    );
  });
});

describe("the collection uses these helpers", () => {
  it("builds the night time from the clinic calendar, not the slots' day", () => {
    const script = readFileSync(
      fileURLToPath(
        new URL(
          "../../../docs/api/clinic-booking.postman_collection.json",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(script).toContain("function nightStart");
    expect(script).not.toContain('slotDay") + \\"T03:00:00');
  });
});

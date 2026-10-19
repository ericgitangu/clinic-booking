import { describe, expect, it } from "vitest";
import {
  applyDrill,
  leadHours,
  weekdayHour,
  type DrillConfig,
  type DrillRow,
} from "@/lib/drill";

const spec = {
  from: "2026-10-01",
  to: "2026-11-01",
  status: "booked" as const,
};
const cfg = (extra: Partial<DrillConfig> = {}): DrillConfig => ({
  title: "t",
  description: "d",
  spec,
  ...extra,
});
const row = (id: string, extra: Partial<DrillRow> = {}): DrillRow => ({
  id,
  doctor_id: "d1",
  doctor_name: "Dr. One",
  patient_name: "P",
  starts_at: "2026-10-20T07:00:00Z", // 10:00 on a Tuesday in Nairobi
  created_at: "2026-10-18T07:00:00Z",
  status: "booked",
  attendance: null,
  ...extra,
});
const NOW = Date.parse("2026-10-20T06:00:00Z");

describe("drill-down rules", () => {
  const rows = [
    row("a"),
    row("b", { attendance: "arrived" }),
    row("c", {
      attendance: "no_show",
      doctor_id: "d2",
      doctor_name: "Dr. Two",
    }),
    row("d", { status: "cancelled" }),
  ];

  it("counts exactly the rows that pass, so the number and the list cannot disagree", () => {
    const all = { status: "all" as const, doctorId: "" };
    expect(applyDrill(rows, cfg(), all, NOW)).toHaveLength(4);
    expect(
      applyDrill(rows, cfg(), { ...all, status: "arrived" }, NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["b"]);
    expect(
      applyDrill(rows, cfg(), { ...all, status: "no_show" }, NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["c"]);
    expect(
      applyDrill(rows, cfg(), { ...all, status: "cancelled" }, NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["d"]);
    expect(
      applyDrill(rows, cfg(), { ...all, status: "booked" }, NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["a"]);
    expect(
      applyDrill(rows, cfg(), { ...all, doctorId: "d2" }, NOW).map((r) => r.id),
    ).toEqual(["c"]);
  });

  it("keeps only visits still to come when asked, by instant not by string", () => {
    const later = row("later", { starts_at: "2026-10-20T10:00:00+03:00" }); // 07:00Z, after NOW
    const earlier = row("earlier", { starts_at: "2026-10-20T08:00:00+03:00" }); // 05:00Z, before NOW
    const out = applyDrill(
      [later, earlier],
      cfg({ upcoming: true }),
      { status: "all", doctorId: "" },
      NOW,
    );
    expect(out.map((r) => r.id)).toEqual(["later"]);
  });

  it("finds the weekday and hour in clinic time, whatever the offset written", () => {
    expect(weekdayHour("2026-10-20T07:00:00Z")).toEqual({
      weekday: 2,
      hour: 10,
    });
    expect(weekdayHour("2026-10-20T10:00:00+03:00")).toEqual({
      weekday: 2,
      hour: 10,
    });
    expect(weekdayHour("2026-10-18T21:00:00Z")).toEqual({
      weekday: 1,
      hour: 0,
    }); // after midnight Monday
    const out = applyDrill(
      rows,
      cfg({ slot: { weekday: 2, hour: 10 } }),
      { status: "all", doctorId: "" },
      NOW,
    );
    expect(out).toHaveLength(4);
    expect(
      applyDrill(
        rows,
        cfg({ slot: { weekday: 3, hour: 10 } }),
        { status: "all", doctorId: "" },
        NOW,
      ),
    ).toHaveLength(0);
  });

  it("measures how far ahead a visit was booked", () => {
    expect(leadHours(row("x"))).toBe(48);
  });
});

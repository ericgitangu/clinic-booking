import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { KpiStrip } from "@/components/kpi-strip";
import { LineageTimeline } from "@/components/lineage-timeline";
import { metadata } from "@/lib/metadata";

describe("dashboard pieces", () => {
  it("draws booked, rescheduled and cancelled in order with the old and new slot", () => {
    const html = renderToStaticMarkup(
      <LineageTimeline
        events={[
          {
            id: 1,
            event_type: "booked",
            from_starts_at: null,
            to_starts_at: "2026-10-22T07:00:00Z",
            occurred_at: "2026-10-17T07:00:00Z",
          },
          {
            id: 2,
            event_type: "rescheduled",
            from_starts_at: "2026-10-22T07:00:00Z",
            to_starts_at: "2026-10-22T08:00:00Z",
            occurred_at: "2026-10-17T08:00:00Z",
          },
          {
            id: 3,
            event_type: "cancelled",
            from_starts_at: "2026-10-22T08:00:00Z",
            to_starts_at: null,
            occurred_at: "2026-10-18T08:00:00Z",
          },
        ]}
      />,
    );
    const order = ["Booked", "Rescheduled", "Cancelled"].map((w) =>
      html.indexOf(w),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Thu 22 Oct 10:00");
    expect(html).toContain("Thu 22 Oct 11:00");
  });

  it("says so when an appointment has no recorded history", () => {
    expect(renderToStaticMarkup(<LineageTimeline events={[]} />)).toContain(
      "No history was recorded",
    );
  });

  it("shows each key number with what it counts", () => {
    const html = renderToStaticMarkup(
      <KpiStrip items={[{ label: "Today", value: "3", note: "booked" }]} />,
    );
    expect(html).toContain("Today");
    expect(html).toContain(">3<");
  });

  it("keeps crawlers out", () => {
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

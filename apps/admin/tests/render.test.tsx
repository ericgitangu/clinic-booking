import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TodayBoard } from "@/components/today-board";
import type { TodayBoard as Board } from "@clinic/api/generated";
import robots from "@/app/robots";
import { AppointmentsList } from "@/components/appointments-list";
import { countDelta } from "@/lib/kpi-delta";
import { KpiStrip } from "@/components/kpi-strip";
import { LineageTimeline } from "@/components/lineage-timeline";
import { metadata } from "@/lib/metadata";

// The action buttons use the app router; a static render has none.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock("@/lib/drill-actions", () => ({
  loadDrill: async () => ({ ok: false, message: "" }),
}));

vi.mock("@/lib/actions", () => ({
  cancelAppointment: async () => ({ ok: true, message: "" }),
  rescheduleAppointment: async () => ({ ok: true, message: "" }),
  loadSlots: async () => ({ ok: true, slots: [] }),
}));

// Visits are placed relative to now, so the attendance window is the same whenever this runs.
const NOW = new Date("2098-12-31T10:00:00Z");
const at = (minutes: number) =>
  new Date(NOW.getTime() + minutes * 60_000).toISOString();

const board: Board = {
  view: "full",
  totals: { booked: 2, arrived: 1, no_show: 0, cancelled: 1 },
  doctors: [
    {
      doctor_id: "d1",
      name: "Dr. Test Doctor",
      specialty: "General",
      date: "2098-12-31",
      timezone: "Africa/Nairobi",
      free_slots: 3,
      next_gap: {
        starts_at: at(120),
        ends_at: at(180),
        slots: 2,
        timezone: "Africa/Nairobi",
      },
      running_behind: { behind: true, minutes: 25, appointment_id: "a1" },
      appointments: [
        {
          id: "a1",
          status: "booked",
          locked: false,
          patient_name: "pat one",
          patient_phone: null,
          starts_at: at(-25),
          ends_at: at(5),
          timezone: "Africa/Nairobi",
        },
        {
          id: "a2",
          status: "arrived",
          locked: false,
          patient_name: "pat two",
          patient_phone: null,
          starts_at: at(-5),
          ends_at: at(25),
          timezone: "Africa/Nairobi",
        },
        {
          id: "a3",
          status: "booked",
          locked: true,
          patient_name: "pat three",
          patient_phone: null,
          starts_at: at(60),
          ends_at: at(90),
          timezone: "Africa/Nairobi",
        },
        {
          id: "a4",
          status: "cancelled",
          locked: false,
          patient_name: "pat four",
          patient_phone: null,
          starts_at: at(30),
          ends_at: at(60),
          timezone: "Africa/Nairobi",
        },
      ],
    },
  ],
};

describe("today board", () => {
  const render = (canAct: boolean, canExport: boolean, b: Board = board) =>
    renderToStaticMarkup(
      <TodayBoard
        board={b}
        date="2098-12-31"
        now={NOW}
        canAct={canAct}
        canExport={canExport}
      />,
    );

  it("shows every status as words, the next free gap and the running-behind flag", () => {
    const html = render(false, false);
    for (const word of ["Booked", "Arrived", "Cancelled"])
      expect(html).toContain(word);
    expect(html).toContain("Running behind");
    expect(html).toContain("25 min ago");
    expect(html).toContain("Next free");
    expect(html).toContain("Pat One");
  });

  it("gives viewers no action buttons and no export", () => {
    const html = render(false, false);
    for (const word of [
      "Mark arrived",
      "Mark no-show",
      "Cancel appointment",
      "Reschedule",
      "Veto and lock",
      "Unlock",
      "day-sheet",
    ]) {
      expect(html).not.toContain(word);
    }
  });

  it("gives owners and admins attendance, move and cancel, and the export", () => {
    const html = render(true, true);
    expect(html).toContain("Mark arrived");
    expect(html).toContain("Mark no-show");
    expect(html).toContain("Change to no-show"); // the visit already marked arrived
    expect(html).toContain("Cancel appointment");
    // The board offers Unlock on a locked visit and no Veto: it cannot tell a patient change is waiting.
    expect(html).toContain("Unlock");
    expect(html).not.toContain("Veto and lock");
    expect(html).toContain("day-sheet");
  });

  it("shows a viewer's initials as the API sent them, untidied", () => {
    const html = render(false, false, {
      ...board,
      view: "minimised",
      doctors: [
        {
          ...board.doctors[0]!,
          appointments: [
            { ...board.doctors[0]!.appointments[0]!, patient_name: "A. O." },
          ],
        },
      ],
    });
    expect(html).toContain("A. O.");
  });
});

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
      <KpiStrip
        comparedWith="the 7 days before"
        items={[
          { label: "Today", value: "3", note: "booked" },
          {
            label: "Cancellations",
            value: "5",
            note: "last 7 days",
            delta: countDelta(5, 2, "down"),
          },
        ]}
      />,
    );
    expect(html).toContain("Today");
    expect(html).toContain(">3<");
    // The change is words, not only an arrow or a colour, and says what it is measured against.
    expect(html).toContain("Up 3 from 2");
    expect(html).toContain("Changes compare with the 7 days before.");
  });

  it("explains an empty appointment list for the chosen filter", () => {
    const html = renderToStaticMarkup(
      <AppointmentsList
        items={[]}
        status="cancelled"
        nextHref={null}
        firstHref={null}
      />,
    );
    expect(html).toContain("No cancellations");
  });

  it("keeps crawlers out", () => {
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BURST_WINDOW_MS,
  HIGHLIGHT_MS,
  Highlights,
  ToastBatcher,
  cardKey,
  cardsTouched,
  nextUnread,
  toastText,
  wantsEmailStatus,
  unreadText,
  type ToastSink,
} from "@/lib/live-notices";
import { parseLiveEvent } from "@/lib/live-events";

const DOCTOR = "e52e9da0-f7f3-5a6a-93d3-d7f658947afa";
const APPT = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";

const viewerShape = (over: Record<string, unknown> = {}) => ({
  event_type: "arrived",
  doctor_id: DOCTOR,
  local_date: "2026-10-21",
  from_local_date: null,
  from_starts_at: null,
  to_starts_at: "2026-10-21T07:30:00.000000Z",
  seq: "845.17",
  ...over,
});
const staffShape = (over: Record<string, unknown> = {}) =>
  viewerShape({
    appointment_id: APPT,
    patient_name: "Wanjiru Kamau",
    cancellation_reason: null,
    actor_email: null,
    actor_role: null,
    staff_reason: null,
    ...over,
  });

function sink() {
  const calls: string[] = [];
  const gone = new Map<string, () => void>();
  const rawSummary: string[] = [];
  let n = 0;
  const s: ToastSink = {
    show: (text, onGone) => {
      const id = `t${(n += 1)}`;
      gone.set(id, onGone);
      calls.push(`show ${id} ${text}`);
      return id;
    },
    dismiss: (id) => calls.push(`dismiss ${id}`),
    // The id is one counter for the page, so its number depends on what ran before: the calls
    // name summaries by order within this sink, and `rawSummary` keeps the real ids.
    summary: (id, text) => {
      if (!rawSummary.includes(id)) rawSummary.push(id);
      calls.push(`summary live-updates-${rawSummary.indexOf(id) + 1} ${text}`);
    },
    update: (id, text, onGone) => {
      gone.set(id, onGone);
      calls.push(`update ${id} ${text}`);
    },
  };
  return { s, calls, gone, rawSummary };
}

describe("ToastBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows three events inside two seconds as three toasts", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    for (const t of ["a", "b", "c"]) {
      b.push(t);
      vi.advanceTimersByTime(500);
    }
    expect(calls).toEqual(["show t1 a", "show t2 b", "show t3 c"]);
  });

  it("turns a fourth inside two seconds into one '4 updates' toast and takes the three away", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    for (const t of ["a", "b", "c", "d"]) {
      b.push(t);
      vi.advanceTimersByTime(400);
    }
    expect(calls.slice(3)).toEqual([
      "dismiss t1",
      "dismiss t2",
      "dismiss t3",
      "summary live-updates-1 4 updates",
    ]);
  });

  it("keeps counting in that one toast while events keep coming", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    for (let i = 0; i < 6; i++) {
      b.push(String(i));
      vi.advanceTimersByTime(300);
    }
    expect(calls.filter((c) => c.startsWith("summary"))).toEqual([
      "summary live-updates-1 4 updates",
      "summary live-updates-1 5 updates",
      "summary live-updates-1 6 updates",
    ]);
    expect(calls.filter((c) => c.startsWith("show"))).toHaveLength(3);
  });

  it("does not count four events spread over more than two seconds", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    for (const t of ["a", "b", "c", "d"]) {
      b.push(t);
      vi.advanceTimersByTime(900);
    }
    expect(calls.every((c) => c.startsWith("show"))).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("starts over after a quiet two seconds", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    for (const t of ["a", "b", "c", "d"]) b.push(t);
    vi.advanceTimersByTime(BURST_WINDOW_MS + 1);
    b.push("e");
    expect(calls.at(-1)).toBe("show t4 e");
    for (const t of ["f", "g", "h"]) b.push(t);
    expect(calls.at(-1)).toBe("summary live-updates-2 4 updates");
  });
});

describe("ToastBatcher follow-up words", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("puts the words on the end of a toast that is still up, replacing the last ones", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    b.push("Marked arrived: A", (add) => {
      add("doctor email on its way");
      add("doctor emailed");
    });
    expect(calls).toEqual([
      "show t1 Marked arrived: A",
      "update t1 Marked arrived: A · doctor email on its way",
      "update t1 Marked arrived: A · doctor emailed",
    ]);
  });

  it("does not bring back a toast that was folded into an 'N updates' toast", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    let late: (x: string) => void = () => undefined;
    b.push("first", (add) => (late = add));
    for (const t of ["b", "c", "d"]) b.push(t);
    late("doctor emailed");
    expect(calls.some((c) => c.startsWith("update"))).toBe(false);
  });
});

describe("ToastBatcher: late words, folds and counts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not bring back a toast that was swiped away or timed out", () => {
    const { s, calls, gone } = sink();
    const b = new ToastBatcher(s);
    let late: (x: string) => void = () => undefined;
    b.push("Marked arrived: A", (add) => (late = add));
    gone.get("t1")?.(); // the person swiped it away
    late("doctor emailed");
    expect(calls).toEqual(["show t1 Marked arrived: A"]);
  });

  it("drops late words once the page that raised the toast is gone", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    let late: (x: string) => void = () => undefined;
    b.push("Marked arrived: A", (add) => (late = add));
    b.dispose();
    late("doctor emailed");
    expect(calls).toEqual(["show t1 Marked arrived: A"]);
  });

  it("tells the follow-up whether its toast is still there, so it can stop asking", () => {
    const { s, gone } = sink();
    const b = new ToastBatcher(s);
    let alive: () => boolean = () => false;
    b.push("x", (_add, a) => (alive = a));
    expect(alive()).toBe(true);
    gone.get("t1")?.();
    expect(alive()).toBe(false);
  });

  it("counts every event whose toast it takes away, even across a longer stretch", () => {
    const { s, calls } = sink();
    const b = new ToastBatcher(s);
    // Three toasts, then two more 2.6 s later, then a sixth: all five are folded, so six updates.
    for (const t of ["a", "b", "c"]) {
      b.push(t);
      vi.advanceTimersByTime(500);
    }
    vi.advanceTimersByTime(1100);
    b.push("d");
    vi.advanceTimersByTime(100);
    b.push("e");
    vi.advanceTimersByTime(100);
    b.push("f");
    expect(calls.at(-1)).toBe("summary live-updates-1 6 updates");
    expect(calls.filter((c) => c.startsWith("dismiss"))).toHaveLength(5);
  });

  it("gives summary ids that are unique across batchers", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const { s, rawSummary } = sink();
      const b = new ToastBatcher(s);
      for (const t of ["a", "b", "c", "d"]) b.push(t);
      ids.add(rawSummary[0]);
    }
    expect(ids.size).toBe(2);
  });
});

describe("what a toast says", () => {
  it("names the patient, the time and the doctor for an owner", () => {
    const ev = parseLiveEvent(JSON.stringify(staffShape()), "owner")!;
    expect(toastText(ev, "Dr. Otieno", "owner")).toMatch(
      /^Marked arrived: Wanjiru Kamau, .*10:30 with Dr\. Otieno/,
    );
  });

  it("gives a viewer no patient and no staff name", () => {
    const ev = parseLiveEvent(JSON.stringify(viewerShape()), "viewer")!;
    const text = toastText(ev, "Dr. Otieno", "viewer");
    expect(text).toMatch(/^Marked arrived: .*10:30 with Dr\. Otieno$/);
    expect(text).not.toContain("Wanjiru");
  });

  it("never reaches a toast when a viewer's message carries a person", () => {
    expect(parseLiveEvent(JSON.stringify(staffShape()), "viewer")).toBeNull();
  });

  it("does not add the staff member to a viewer's vetoed toast", () => {
    const ev = parseLiveEvent(
      JSON.stringify(viewerShape({ event_type: "vetoed" })),
      "viewer",
    )!;
    expect(toastText(ev, undefined, "viewer")).toMatch(/^Vetoed\. /);
  });
});

describe("the doctor's email in a toast", () => {
  it("is asked about for an owner's or admin's arrival, never a viewer's", () => {
    const owner = parseLiveEvent(JSON.stringify(staffShape()), "owner")!;
    expect(wantsEmailStatus(owner, "owner")).toBe(true);
    expect(wantsEmailStatus(owner, "admin")).toBe(true);
    const viewer = parseLiveEvent(JSON.stringify(viewerShape()), "viewer")!;
    expect(wantsEmailStatus(viewer, "viewer")).toBe(false);
    const booked = parseLiveEvent(
      JSON.stringify(staffShape({ event_type: "booked" })),
      "owner",
    )!;
    expect(wantsEmailStatus(booked, "owner")).toBe(false);
    // A tab nobody is looking at does not ask.
    expect(wantsEmailStatus(owner, "owner", true)).toBe(false);
  });
});

describe("cards and highlights", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("touches the doctor's card for the day of the visit and the day it moved from", () => {
    const ev = parseLiveEvent(
      JSON.stringify(
        viewerShape({
          event_type: "rescheduled",
          from_local_date: "2026-10-20",
        }),
      ),
      "viewer",
    )!;
    expect(cardsTouched(ev)).toEqual([
      cardKey(DOCTOR, "2026-10-21"),
      cardKey(DOCTOR, "2026-10-20"),
    ]);
  });

  it("touches no card for a staff action that changes no visit", () => {
    const ev = parseLiveEvent(
      JSON.stringify({
        kind: "reminder_now",
        doctor_id: DOCTOR,
        starts_at: "2026-10-21T06:30:00.000000Z",
        delay_minutes: null,
        seq: "860.31",
      }),
      "viewer",
    )!;
    expect(cardsTouched(ev)).toEqual([]);
  });

  it("marks a card for two seconds, renews it on another change, then lets go", () => {
    const h = new Highlights();
    const seen = vi.fn();
    h.subscribe(seen);
    h.mark("k");
    expect(h.has("k")).toBe(true);
    vi.advanceTimersByTime(HIGHLIGHT_MS - 100);
    h.mark("k");
    vi.advanceTimersByTime(HIGHLIGHT_MS - 100);
    expect(h.has("k")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(h.has("k")).toBe(false);
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

describe("unread count", () => {
  it("counts a live event while the panel is out of view", () => {
    expect(nextUnread(0, { replay: false }, false)).toBe(1);
    expect(nextUnread(4, { replay: false }, false)).toBe(5);
  });

  it("counts nothing while the panel is in view, and nothing for a replay", () => {
    expect(nextUnread(0, { replay: false }, true)).toBe(0);
    expect(nextUnread(2, { replay: true }, false)).toBe(2);
  });

  it("is said in words, and silent at zero", () => {
    expect(unreadText(0)).toBe("");
    expect(unreadText(3)).toBe("3 new");
    expect(unreadText(150)).toBe("99+ new");
  });
});

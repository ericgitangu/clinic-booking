import type { Availability } from "@clinic/api/generated";
import { describe, expect, it } from "vitest";
import { compareSeq, cursorNotOlder, parseSeq } from "@/lib/cursor";
import {
  acceptPolled,
  applyEvent,
  reapplyTaken,
  withTaken,
} from "@/lib/live-availability";

const D = "doc";
const day = "2027-01-04";
const at = (h: string) => `2027-01-04T${h}:00+03:00`;
const avail = (
  cursor: string,
  free: string[],
  taken: string[] = [],
): Availability => ({
  cursor,
  date: day,
  doctor_id: D,
  slots: free.map((h) => ({ starts_at: at(h), ends_at: at(h) })),
  taken: taken.map(at),
  timezone: "Africa/Nairobi",
});
const ev = (seq: string, kind: "slot_taken" | "slot_freed", h: string) => ({
  doctor_id: D,
  local_date: day,
  kind,
  seq,
  starts_at: new Date(at(h)).toISOString(),
});

describe("cursor order", () => {
  it("compares as integers, txid first", () => {
    expect(compareSeq(parseSeq("10.1")!, parseSeq("9.99")!)).toBe(1);
    expect(compareSeq(parseSeq("9.100.1")!, parseSeq("9.99.1")!)).toBe(1);
    expect(compareSeq(parseSeq("9.9.0")!, parseSeq("9.9.1")!)).toBe(-1);
    expect(compareSeq(parseSeq("9.9.0")!, parseSeq("9.9.1")!, 2)).toBe(0);
    expect(parseSeq("nope")).toBeNull();
  });
  it("accepts an equal or newer cursor and refuses an older one", () => {
    expect(cursorNotOlder("5.2", "5.2")).toBe(true);
    expect(cursorNotOlder("5.3", "5.2")).toBe(true);
    expect(cursorNotOlder("5.1", "5.2")).toBe(false);
    expect(cursorNotOlder("12.1", "9.5")).toBe(true);
  });
});

describe("RULE 1: polled responses", () => {
  it("keeps what is on screen when a slower, older response arrives", () => {
    const now = avail("7.5", ["08:30"]);
    expect(acceptPolled(now, avail("7.4", ["08:00", "08:30"]))).toBe(now);
  });
  it("takes a response that is not older", () => {
    const next = avail("7.6", ["09:00"]);
    expect(acceptPolled(avail("7.5", ["08:30"]), next)).toBe(next);
  });
});

describe("RULE 2: pushed events", () => {
  it("removes a taken slot at once and keeps the response's own cursor", () => {
    const r = applyEvent(
      avail("7.5", ["08:00", "08:30"]),
      null,
      ev("7.6.1", "slot_taken", "08:00"),
    );
    expect(r.effect).toBe("taken");
    expect(r.data.slots.map((s) => s.starts_at)).toEqual([at("08:30")]);
    expect(r.data.taken).toHaveLength(1);
    expect(r.data.cursor).toBe("7.5");
    expect(r.lastSeq).toBe("7.6.1");
  });
  it("applies a duplicate delivery once", () => {
    const first = applyEvent(
      avail("7.5", ["08:00", "08:30"]),
      null,
      ev("7.6.1", "slot_taken", "08:00"),
    );
    const again = applyEvent(
      first.data,
      first.lastSeq,
      ev("7.6.1", "slot_taken", "08:00"),
    );
    expect(again.effect).toBe("ignored");
    expect(again.data).toBe(first.data);
  });
  it("ignores an out-of-order older event", () => {
    const r = applyEvent(
      avail("7.5", ["08:00"]),
      "7.9.1",
      ev("7.8.1", "slot_taken", "08:00"),
    );
    expect(r.effect).toBe("ignored");
  });
  it("ignores an event the response on screen already reflects", () => {
    const r = applyEvent(
      avail("7.6", ["08:30"], ["08:00"]),
      null,
      ev("7.6.1", "slot_taken", "08:00"),
    );
    expect(r.effect).toBe("ignored");
  });
  it("asks for one refetch on a freed slot and does not add the time itself", () => {
    const data = avail("7.5", ["08:30"], ["08:00"]);
    const r = applyEvent(data, null, ev("7.7.0", "slot_freed", "08:00"));
    expect(r.effect).toBe("freed");
    expect(r.data).toBe(data);
  });
  it("ignores another doctor or day", () => {
    const other = { ...ev("7.7.1", "slot_taken", "08:00"), doctor_id: "x" };
    expect(applyEvent(avail("7.5", ["08:00"]), null, other).effect).toBe(
      "ignored",
    );
  });
});

describe("RULE 3: a confirmed 409 or the patient's own booking", () => {
  it("removes the slot and lists it as taken", () => {
    const r = withTaken(avail("7.5", ["08:00", "08:30"]), at("08:00"));
    expect(r.slots).toHaveLength(1);
    expect(r.taken).toEqual([at("08:00")]);
    expect(withTaken(r, at("08:00")).taken).toHaveLength(1);
  });
});

describe("a freed time after a taken one, with another writer open", () => {
  // The server's cursor is "<xmin>.0" (the oldest open transaction), which can sit BEHIND the
  // (txid, id) of an event already pushed. A refetch after a freed event must still show the time.
  it("shows the time free when the refetch carries an older xmin cursor", () => {
    let shown = avail("7.0", ["08:00", "08:30"]);
    let last: string | null = null;

    const taken = applyEvent(shown, last, ev("9.4.1", "slot_taken", "08:00"));
    shown = taken.data;
    last = taken.lastSeq;
    expect(shown.slots.map((s) => s.starts_at)).toEqual([at("08:30")]);

    // someone else's transaction is still open: the cursor is behind the event
    shown = acceptPolled(shown, avail("8.0", ["08:30"], ["08:00"]));

    const freed = applyEvent(shown, last, ev("9.6.0", "slot_freed", "08:00"));
    expect(freed.effect).toBe("freed");

    shown = acceptPolled(shown, avail("8.0", ["08:00", "08:30"]));
    expect(shown.slots.map((s) => s.starts_at)).toEqual([
      at("08:00"),
      at("08:30"),
    ]);
  });
});

describe("a polled response older than a taken event", () => {
  it("is shown without the time the event took", () => {
    const stale = avail("8.0", ["08:00", "08:30"]);
    const out = reapplyTaken(stale, [{ startsAt: at("08:00"), seq: "9.4.1" }]);
    expect(out.slots.map((s) => s.starts_at)).toEqual([at("08:30")]);
  });
  it("is left alone once its cursor has reached the event", () => {
    const fresh = avail("9.4", ["08:00"]);
    expect(reapplyTaken(fresh, [{ startsAt: at("08:00"), seq: "9.4.1" }])).toBe(
      fresh,
    );
  });
});

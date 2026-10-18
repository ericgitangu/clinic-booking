import { describe, expect, it } from "vitest";
import {
  addOwn,
  buildChips,
  heldAt,
  removeOwn,
  type OwnBooking,
} from "@/lib/slot-chips";

const DOC = "doc-1";
const OTHER = "doc-2";
const at = (hhmm: string) => `2027-01-04T${hhmm}:00+03:00`;
const free = (...t: string[]) => t.map((h) => ({ starts_at: at(h) }));
const base = {
  doctorId: DOC,
  day: "2027-01-04",
  own: [],
  seen: [] as string[],
};

describe("heldAt", () => {
  const own: OwnBooking[] = [{ starts_at: at("08:00"), doctor_id: OTHER }];
  it("finds a booking at the same instant, whatever offset it is written in", () => {
    expect(heldAt(own, "2027-01-04T05:00:00Z")?.doctor_id).toBe(OTHER);
    expect(heldAt(own, at("08:00"))?.doctor_id).toBe(OTHER);
  });
  it("does not match another time", () => {
    expect(heldAt(own, at("08:30"))).toBeUndefined();
  });
});

describe("buildChips", () => {
  it("shows free times as free chips in time order", () => {
    const chips = buildChips({ ...base, slots: free("09:00", "08:30") });
    expect(chips.map((c) => [c.starts_at, c.state])).toEqual([
      [at("08:30"), "free"],
      [at("09:00"), "free"],
    ]);
  });

  it("puts the patient's own visit with this doctor in its place, inactive, labelled Your visit", () => {
    const chips = buildChips({
      ...base,
      slots: free("08:30", "09:00"),
      own: [{ starts_at: at("08:00"), doctor_id: DOC }],
    });
    expect(chips.map((c) => c.state)).toEqual(["yours", "free", "free"]);
    expect(chips[0]).toMatchObject({
      starts_at: at("08:00"),
      label: "Your visit",
    });
  });

  it("marks a free time inactive when the patient has another doctor at that time", () => {
    const chips = buildChips({
      ...base,
      slots: free("08:00", "08:30"),
      own: [{ starts_at: at("08:00"), doctor_id: OTHER }],
    });
    expect(chips[0]).toMatchObject({
      state: "yours-elsewhere",
      label: "You have another visit",
    });
    expect(chips[1].state).toBe("free");
  });

  it("ignores the patient's visits on other days and does not invent chips for other doctors' times", () => {
    const chips = buildChips({
      ...base,
      slots: free("09:00"),
      own: [
        { starts_at: "2027-01-05T08:00:00+03:00", doctor_id: DOC },
        { starts_at: at("10:00"), doctor_id: OTHER },
      ],
    });
    expect(chips.map((c) => c.starts_at)).toEqual([at("09:00")]);
  });

  it("keeps a time that left the list, for whatever reason, in place as No longer available", () => {
    const chips = buildChips({
      ...base,
      seen: [at("08:00"), at("08:30"), at("09:00")],
      slots: free("08:00", "09:00"),
    });
    expect(chips.map((c) => [c.starts_at, c.state])).toEqual([
      [at("08:00"), "free"],
      [at("08:30"), "gone"],
      [at("09:00"), "free"],
    ]);
    expect(chips[1].label).toBe("No longer available");
  });

  it("says Just taken only for a time confirmed taken (a 409 or a slot_taken event)", () => {
    const chips = buildChips({
      ...base,
      seen: [at("08:00"), at("08:30"), at("09:00")],
      slots: free("08:00", "09:00"),
      confirmedTaken: [at("08:30")],
    });
    expect(chips[1]).toMatchObject({
      state: "just-taken",
      label: "Just taken",
    });
    // A confirmed time that is somehow free again is free: the live list wins.
    const again = buildChips({
      ...base,
      seen: [],
      slots: free("08:30"),
      confirmedTaken: [at("08:30")],
    });
    expect(again[0].state).toBe("free");
  });

  it("does not call the patient's own new booking taken or gone", () => {
    const chips = buildChips({
      ...base,
      seen: [at("08:00")],
      slots: [],
      own: [{ starts_at: at("08:00"), doctor_id: DOC }],
    });
    expect(chips).toEqual([
      { starts_at: at("08:00"), state: "yours", label: "Your visit" },
    ]);
  });

  it("renders every taken time the response lists (optional field) as an inactive Booked chip", () => {
    const chips = buildChips({
      ...base,
      slots: free("09:00"),
      taken: [at("08:00"), at("09:00")], // 09:00 is free and stays free: the free list wins
    });
    expect(chips.map((c) => [c.starts_at, c.state, c.label])).toEqual([
      [at("08:00"), "booked", "Booked"],
      [at("09:00"), "free", null],
    ]);
  });
});

describe("Just taken wins over Booked", () => {
  it("shows a time confirmed taken as Just taken even though the response now lists it as taken", () => {
    const chips = buildChips({
      ...base,
      slots: free("09:00"),
      taken: [at("08:00")],
      confirmedTaken: [at("08:00")],
    });
    expect(chips[0]).toMatchObject({
      state: "just-taken",
      label: "Just taken",
    });
  });
});

describe("own booking bookkeeping", () => {
  const a: OwnBooking = { starts_at: at("08:00"), doctor_id: DOC };
  it("adds a booking once and removes it by time", () => {
    const one = addOwn([], a);
    expect(addOwn(one, a)).toHaveLength(1);
    expect(removeOwn(one, "2027-01-04T05:00:00Z")).toEqual([]);
  });
});

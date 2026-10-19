import { describe, expect, it } from "vitest";
import { canVeto, type VetoEvent } from "@/lib/veto";

const booked: VetoEvent = { event_type: "booked", actor: "patient" };
const movedByPatient: VetoEvent = {
  event_type: "rescheduled",
  actor: "patient",
};
const movedByStaff: VetoEvent = { event_type: "rescheduled", actor: "staff" };

describe("when Veto and lock is offered", () => {
  it("is offered after a patient's move", () => {
    expect(canVeto([booked, movedByPatient], "booked", false)).toBe(true);
  });

  it("is not offered when nothing was changed, or only staff changed it", () => {
    expect(canVeto([booked], "booked", false)).toBe(false);
    expect(canVeto([booked, movedByStaff], "booked", false)).toBe(false);
    expect(canVeto([], "booked", false)).toBe(false);
  });

  it("is not offered once staff moved it after the patient did (nothing left to undo)", () => {
    expect(
      canVeto([booked, movedByPatient, movedByStaff], "booked", false),
    ).toBe(false);
  });

  it("is not offered for a cancelled visit or a locked one", () => {
    expect(canVeto([booked, movedByPatient], "cancelled", false)).toBe(false);
    expect(canVeto([booked, movedByPatient], "booked", true)).toBe(false);
  });

  it("treats an event with no recorded actor as not the patient's", () => {
    expect(
      canVeto(
        [booked, { event_type: "rescheduled", actor: null }],
        "booked",
        false,
      ),
    ).toBe(false);
  });
});

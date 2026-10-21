import { describe, expect, it } from "vitest";
import { isToastKind } from "@/components/live-notifications";

describe("which live events pop a toast", () => {
  it("keeps access changes out, invitations and reviewer passes alike", () => {
    for (const kind of [
      "invite_created",
      "invite_revoked",
      "invite_accepted",
      "pass_created",
      "pass_revoked",
      "pass_accepted",
    ])
      expect(isToastKind(kind), kind).toBe(false);
  });

  it("still toasts clinic activity", () => {
    for (const kind of ["booked", "cancelled", "rescheduled", "running_late"])
      expect(isToastKind(kind), kind).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { can, type Capability, type Role } from "@/lib/roles";

const CAPS: Capability[] = ["view", "manage-appointments", "manage-access"];

describe("role capabilities", () => {
  const matrix: Record<Role | "none", boolean[]> = {
    owner: [true, true, true],
    admin: [true, true, false],
    viewer: [true, false, false],
    none: [false, false, false],
  };
  for (const [role, expected] of Object.entries(matrix)) {
    it(`${role}: ${expected.map(String).join(", ")}`, () => {
      const r = role === "none" ? null : (role as Role);
      expect(CAPS.map((c) => can(r, c))).toEqual(expected);
    });
  }
});

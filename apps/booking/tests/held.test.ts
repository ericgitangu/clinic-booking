import { describe, expect, it } from "vitest";
import { heldMessage } from "@/lib/held";

describe("heldMessage", () => {
  it("names the time and the doctor when the patient already holds that time", () => {
    const m = heldMessage({
      sameDoctor: true,
      when: "Monday 19 October, 08:00",
      doctor: "Dr. Achieng Otieno",
    });
    expect(m).toContain("Monday 19 October, 08:00");
    expect(m).toContain("Dr. Achieng Otieno");
    expect(m).toMatch(/already (booked|have)/i);
    expect(m).toMatch(/My appointments|another time/i);
  });

  it("says it is a different doctor when it is", () => {
    const m = heldMessage({
      sameDoctor: false,
      when: "Monday 19 October, 08:00",
      doctor: "Dr. Brian Kamau",
    });
    expect(m).toMatch(/another doctor|Dr. Brian Kamau/);
  });
});

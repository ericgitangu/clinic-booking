import { describe, expect, it } from "vitest";
import { emailProblem } from "@/lib/doctor-email-check";

describe("emailProblem", () => {
  it("accepts a plain address and an empty field", () => {
    expect(emailProblem("dr.otieno@clinic.org")).toBeNull();
    expect(emailProblem("  Dr.Otieno@Clinic.org ")).toBeNull();
    expect(emailProblem("")).toBeNull();
  });

  it.each([
    ["otieno", "Add the part after the @"],
    ["a b@clinic.org", "Remove the spaces"],
    ["a@@clinic.org", "single @"],
    ["a@b@clinic.org", "single @"],
    ["a@clinic", "name@clinic.org"],
    ["@clinic.org", "name@clinic.org"],
  ])("says what is wrong with %s", (text, words) => {
    expect(emailProblem(text)).toContain(words);
  });
});

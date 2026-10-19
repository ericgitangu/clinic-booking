import { describe, expect, it } from "vitest";
import { detailsHref } from "@/components/booking/slot-links";

// What the grid looks like and how it behaves (a free time is a link named by its time, anything
// else is text with no link, in time order) is checked in a real browser: e2e/deeplinks.spec.ts.
describe("detailsHref", () => {
  it("puts the doctor in the path and the encoded time in the query", () => {
    expect(detailsHref("d", "2027-01-04T08:30:00+03:00")).toBe(
      "/book/d/details?starts_at=2027-01-04T08%3A30%3A00%2B03%3A00",
    );
  });
});

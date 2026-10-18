import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlotLinks, detailsHref } from "@/components/booking/slot-links";
import type { Chip } from "@/lib/slot-chips";

const at = (hhmm: string) => `2027-01-04T${hhmm}:00+03:00`;
const chips: Chip[] = [
  { starts_at: at("08:00"), state: "yours", label: "Your visit" },
  { starts_at: at("08:30"), state: "free", label: null },
  { starts_at: at("09:00"), state: "booked", label: "Booked" },
  { starts_at: at("09:30"), state: "just-taken", label: "Just taken" },
];
const html = renderToStaticMarkup(<SlotLinks chips={chips} doctorId="doc-1" />);
const item = (hhmm: string) =>
  new RegExp(`<li[^>]*data-time="${hhmm}"[^>]*>.*?</li>`).exec(html)?.[0] ?? "";

describe("SlotLinks", () => {
  it("renders a free time as a real anchor to its details page", () => {
    const li = item("08:30");
    expect(li).toContain('data-state="free"');
    expect(li).toContain(
      `href="${detailsHref("doc-1", at("08:30")).replace(/\+/g, "%2B")}"`,
    );
    expect(li).toContain("free, book this time");
  });

  it.each(["08:00", "09:00", "09:30"])(
    "%s has no anchor, no input and no tab stop",
    (t) => {
      const li = item(t);
      expect(li).not.toMatch(/<a[\s>]|<input|<button|tabindex/);
    },
  );

  it("says why an inactive time is inactive", () => {
    expect(item("09:00")).toContain("Booked");
    expect(item("09:30")).toContain("Just taken");
  });

  it("encodes the slot in the URL", () => {
    expect(detailsHref("d", "2027-01-04T08:30:00+03:00")).toBe(
      "/book/d/details?starts_at=2027-01-04T08%3A30%3A00%2B03%3A00",
    );
  });
});

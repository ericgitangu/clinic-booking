import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlotRadios } from "@/components/booking/slot-radios";
import type { Chip } from "@/lib/slot-chips";

const at = (hhmm: string) => `2027-01-04T${hhmm}:00+03:00`;
const chips: Chip[] = [
  { starts_at: at("08:00"), state: "yours", label: "Your visit" },
  { starts_at: at("08:30"), state: "free", label: null },
  {
    starts_at: at("09:00"),
    state: "yours-elsewhere",
    label: "You have another visit",
  },
  { starts_at: at("09:30"), state: "just-taken", label: "Just taken" },
  { starts_at: at("10:00"), state: "booked", label: "Booked" },
];

const html = renderToStaticMarkup(
  <SlotRadios chips={chips} value={at("08:30")} onChange={() => {}} />,
);
const inputFor = (hhmm: string) =>
  new RegExp(`<input[^>]*value="${at(hhmm).replace(/\+/g, "\\+")}"[^>]*>`).exec(
    html,
  )?.[0] ?? "";

describe("SlotRadios", () => {
  it("keeps free times as selectable radios", () => {
    const free = inputFor("08:30");
    expect(free).toContain('type="radio"');
    expect(free).not.toContain("disabled");
    expect(free).toContain("checked");
  });

  it.each(["08:00", "09:00", "09:30", "10:00"])(
    "%s is a disabled radio with aria-disabled, so it cannot be selected or focused",
    (t) => {
      const input = inputFor(t);
      expect(input).toContain("disabled");
      expect(input).toContain('aria-disabled="true"');
    },
  );

  it("says why each inactive time is inactive, in words", () => {
    for (const label of [
      "Your visit",
      "You have another visit",
      "Just taken",
      "Booked",
    ])
      expect(html).toContain(label);
  });

  it("keeps the order it was given and gives every chip a 44px-or-taller target", () => {
    const order = [...html.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(chips.map((c) => c.starts_at));
    expect(html.match(/min-h-14/g)).toHaveLength(chips.length);
  });
});

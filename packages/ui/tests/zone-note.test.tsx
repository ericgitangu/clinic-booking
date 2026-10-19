import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZoneNote } from "../src/components/zone-note";
import { ZONE_NOTE } from "../src/lib/zone-note";

describe("zone note", () => {
  it("names the zone as plain, visible text", () => {
    const html = renderToStaticMarkup(<ZoneNote />);
    expect(ZONE_NOTE).toBe("Times in Nairobi time (EAT, UTC+3)");
    expect(html).toContain(`${ZONE_NOTE}.`);
    expect(html).not.toContain("aria-hidden");
    expect(html).not.toContain("title=");
    expect(html).toContain("text-muted-foreground");
  });

  it("can carry a short follow-on in the same sentence line", () => {
    const html = renderToStaticMarkup(<ZoneNote>30 minutes.</ZoneNote>);
    expect(html.replace(/<[^>]+>/g, "")).toBe(`${ZONE_NOTE}. 30 minutes.`);
  });
});

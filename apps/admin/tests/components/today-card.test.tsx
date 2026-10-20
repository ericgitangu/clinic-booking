import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdatedTag } from "@/components/today-card";

describe("the Updated tag on a doctor's card", () => {
  it("names the doctor for a screen reader and is not a live region", () => {
    const html = renderToStaticMarkup(
      <UpdatedTag changed doctorName="Dr. Achieng Otieno" />,
    );
    expect(html).toContain("Updated");
    expect(html).toMatch(/sr-only[^>]*>: Dr\. Achieng Otieno/);
    expect(html).not.toContain("aria-live");
  });

  it("is not there when the card is not marked", () => {
    expect(
      renderToStaticMarkup(<UpdatedTag changed={false} doctorName="Dr. X" />),
    ).toBe("");
  });
});

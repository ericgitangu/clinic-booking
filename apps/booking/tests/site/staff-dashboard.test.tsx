import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/landing/status-line", () => ({
  StatusLine: () => null,
  StatusPending: () => null,
}));
import Home from "@/app/page";
import { StaffDashboard } from "@/components/landing/staff-dashboard";

describe("staff dashboard on the landing page", () => {
  it("adds a hero button to the admin app, opening in the same tab like its neighbours", () => {
    const html = renderToStaticMarkup(<Home />);
    const a =
      /<a [^>]*href="https:\/\/clinic-admin\.ericgitangu\.com"[^>]*>/.exec(
        html,
      )?.[0];
    expect(a).toBeDefined();
    expect(a).not.toContain("target=");
    expect(html).toContain("Open the staff dashboard");
    expect(html.indexOf("Open the staff dashboard")).toBeLessThan(
      html.indexOf("For clinic staff"),
    );
  });

  it("renders the section with its four points, the invitation line and both screenshots", () => {
    const html = renderToStaticMarkup(<StaffDashboard />);
    expect(html).toContain("For clinic staff");
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html).toContain("audit trail");
    expect(html).toContain("Access is by invitation from the owner.");
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img).toMatch(/alt="[^"]{20,}"/);
      expect(img).toContain("live feed");
      expect(img).toContain("Arrived");
      expect(img).toContain('width="1280"');
      expect(img).toContain('height="1576"');
      expect(img).toContain("sizes=");
    }
  });
});

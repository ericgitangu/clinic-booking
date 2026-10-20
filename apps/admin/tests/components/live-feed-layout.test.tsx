import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The panel's markup is what is under test; it never reaches the server action or the stream here.
vi.mock("@/lib/actions", () => ({ refreshMetrics: async () => undefined }));

import { LiveFeed } from "@/components/live-feed";

const html = renderToStaticMarkup(
  <LiveFeed role="owner" person="p" doctors={[]} />,
);

function classOf(testid: string): string {
  const m = html.match(
    new RegExp(`<[^>]*data-testid="${testid}"[^>]*class="([^"]*)"`),
  );
  const m2 = html.match(
    new RegExp(`<[^>]*class="([^"]*)"[^>]*data-testid="${testid}"`),
  );
  return (m?.[1] ?? m2?.[1] ?? "").trim();
}

describe("live feed panel height", () => {
  it("reserves a fixed, scrolling event area before any event or connection", () => {
    const cls = classOf("live-scroll");
    expect(cls).toContain("h-60");
    expect(cls).toContain("overflow-y-auto");
    // the empty/connecting state sits inside that same area
    const area = html.slice(html.indexOf('data-testid="live-scroll"'));
    expect(area).toContain('data-testid="live-empty"');
  });

  it("keeps the area a named, focusable region and the list live", () => {
    expect(html).toMatch(/role="region"[^>]*aria-label="Recent events"/);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-testid="live-status"');
  });

  it("holds the header to one fixed row so Connecting, Live and Resume do not change it", () => {
    expect(html).toContain("min-h-11");
    expect(html).toContain("flex-nowrap");
  });
});

describe("live feed unread count", () => {
  it("has its place in the header from the first paint, empty and polite", () => {
    expect(html).toMatch(/data-testid="live-unread"[^>]*aria-live="polite"/);
    expect(html).toMatch(/data-testid="live-unread"[^>]*data-count="0"/);
    const cls = classOf("live-unread");
    // a fixed box that is hidden, not removed, at zero: the row does not change height or width
    expect(cls).toContain("h-6");
    expect(cls).toContain("min-w-14");
    expect(cls).toContain("invisible");
    expect(html).not.toMatch(/data-testid="live-unread"[^>]*>[^<]+</);
  });

  it("makes no sound", () => {
    expect(html).not.toMatch(/<audio|autoplay/i);
  });
});

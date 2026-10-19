import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyBlock } from "@/components/landing/copy-block";

describe("CopyBlock", () => {
  it("makes the scrolling code region reachable by keyboard and names it by what it holds", () => {
    const html = renderToStaticMarkup(
      <CopyBlock code="curl localhost:8080/ready" label="Check the API" />,
    );
    const pre = /<pre[^>]*>/.exec(html)?.[0] ?? "";
    expect(pre).toContain('tabindex="0"');
    expect(pre).toContain('role="region"');
    expect(pre).toContain('aria-label="Command to copy: Check the API"');
  });
});

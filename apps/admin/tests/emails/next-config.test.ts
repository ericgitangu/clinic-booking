import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("the invite page headers", () => {
  it("keep the path token out of the Referer and out of caches", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === "/invite/:token");
    expect(rule).toBeDefined();
    const h = Object.fromEntries(rule!.headers.map((x) => [x.key, x.value]));
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["X-Robots-Tag"]).toBe("noindex");
  });
});

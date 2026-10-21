import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe.each(["/invite/:token", "/pass/:token"])(
  "the %s page headers",
  (source) => {
    it("keep the path token out of the Referer and out of caches", async () => {
      const rules = await nextConfig.headers!();
      const rule = rules.find((r) => r.source === source);
      expect(rule).toBeDefined();
      const h = Object.fromEntries(rule!.headers.map((x) => [x.key, x.value]));
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      expect(h["Cache-Control"]).toBe("no-store");
      expect(h["X-Robots-Tag"]).toBe("noindex");
    });
  },
);

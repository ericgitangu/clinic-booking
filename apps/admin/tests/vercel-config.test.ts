import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The live-feed route holds a gateway stream for up to 290 s, and each open stream takes a whole
// gateway instance (concurrency 1, at most 2 instances). Vercel only fires request.signal when the
// browser disconnects if the function opts in to cancellation; without it the route keeps its
// upstream fetch open after the tab goes away, so one reload or tab switch leaves a dead stream
// holding an instance and the next viewer gets "Live feed busy".
const config = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../vercel.json", import.meta.url)),
    "utf8",
  ),
) as {
  functions: Record<
    string,
    { supportsCancellation?: boolean; maxDuration?: number }
  >;
};

describe("vercel.json", () => {
  it("lets a browser disconnect cancel the live-feed stream", () => {
    const route = config.functions["src/app/live/stream/route.ts"];
    expect(route?.supportsCancellation).toBe(true);
  });

  it("keeps the stream route under Vercel's 300 s cap, above the gateway's 290 s lifetime", () => {
    const route = config.functions["src/app/live/stream/route.ts"];
    expect(route?.maxDuration).toBe(300);
  });
});

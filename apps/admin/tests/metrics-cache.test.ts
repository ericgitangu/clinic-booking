import { describe, expect, it } from "vitest";
import {
  METRICS_TAG,
  METRICS_TTL_SECONDS,
  assertMayReadMetrics,
  metricsCachePlan,
} from "@/lib/metrics-cache";
import { ROLES } from "@/lib/roles";

describe("metrics cache plan", () => {
  it("lives sixty seconds under the admin-metrics tag", () => {
    const plan = metricsCachePlan("2026-10-04", "2026-10-18", "day");
    expect(plan.options).toEqual({ revalidate: 60, tags: ["admin-metrics"] });
    expect(METRICS_TTL_SECONDS).toBe(60);
    expect(METRICS_TAG).toBe("admin-metrics");
  });

  it("keys on the query only, so every role shares one clinic-wide entry", () => {
    const plan = metricsCachePlan("2026-10-04", "2026-10-18", "day");
    expect(plan.keyParts).toEqual([
      "admin-metrics",
      "2026-10-04",
      "2026-10-18",
      "day",
    ]);
    // Different ranges are different entries.
    expect(
      metricsCachePlan("2026-10-11", "2026-10-18", "day").keyParts,
    ).not.toEqual(plan.keyParts);
  });
});

describe("the gate in front of the cache", () => {
  it("lets every role that may view the dashboard through", () => {
    for (const role of ROLES)
      expect(() => assertMayReadMetrics(role)).not.toThrow();
  });

  it("refuses someone with no role, before any cached value could be returned", () => {
    expect(() => assertMayReadMetrics(null)).toThrow(/not available/);
  });
});

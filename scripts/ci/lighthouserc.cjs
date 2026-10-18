// Lighthouse CI config (docs/adr/0026). Run by scripts/ci/lighthouse.sh against the booking app's
// production build served by `next start`.
//
// Budgets are minimum category scores (0..1). Aggregation is `median` on purpose: the median of each
// category over the runs of a page. lhci's default is `optimistic` (the best run) and `median-run`
// asserts on the single run closest to the median, which can hide a noisy page behind one lucky
// representative run (the first CI run saw `/` at 0.72, 0.84 and 0.89 and passed that way).
// `median` reports what a typical visit scores and never lets one run speak for the others.
//
// Measured on CircleCI (e2e-real, pipeline 127, 5 runs per page): performance medians `/` 89,
// /about 93, /book 92, /data 94. Accessibility, best practices and SEO were 100 on every run. `/`
// ranged 79 to 92 (LCP median 2.9 s), so it sits closest to the 0.85 budget; the budget is not
// lowered and every assertion below is a hard gate. If `/` starts failing, fix the page (largest
// contentful paint is the hero paragraph), not the budget or the aggregation.
const base = process.env.LHCI_BASE_URL || "http://localhost:3100";
const paths = ["/", "/book", "/about", "/data"];
const min = (key, fallback) => Number(process.env[key] || fallback);
const median = (level, minScore) => [level, { minScore, aggregationMethod: "median" }];

const perf = min("LH_MIN_PERFORMANCE", 0.85);
const rest = {
  "categories:accessibility": median("error", min("LH_MIN_ACCESSIBILITY", 0.95)),
  "categories:best-practices": median("error", min("LH_MIN_BEST_PRACTICES", 0.95)),
  "categories:seo": median("error", min("LH_MIN_SEO", 0.95)),
};

module.exports = {
  ci: {
    collect: {
      url: paths.map((p) => `${base}${p}`),
      numberOfRuns: Number(process.env.LH_RUNS || 5),
      settings: {
        // Lighthouse's default: mobile emulation with simulated slow 4G.
        chromeFlags: "--no-sandbox --headless=new",
      },
    },
    assert: {
      assertMatrix: [
        {
          matchingUrlPattern: ".*",
          assertions: { ...rest, "categories:performance": median("error", perf) },
        },
      ],
    },
    upload: { target: "filesystem", outputDir: process.env.LHCI_OUTPUT_DIR || "/tmp/lighthouse" },
  },
};

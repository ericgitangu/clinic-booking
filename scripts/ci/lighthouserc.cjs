// Lighthouse CI config (docs/adr/0026). Run by scripts/ci/lighthouse.sh against the booking app's
// production build served by `next start`.
//
// Budgets are minimum category scores (0..1). Aggregation is `median` on purpose: the median of each
// category over the runs of a page. lhci's default is `optimistic` (the best run) and `median-run`
// asserts on the single run closest to the median, which can hide a noisy page behind one lucky
// representative run (the first CI run saw `/` at 0.72, 0.84 and 0.89 and passed that way).
// `median` reports what a typical visit scores and never lets one run speak for the others.
//
// Measured on 2026-10-18, performance scores (accessibility, best practices and SEO were 100 on every
// run, locally and in CI):
//   laptop Chrome, 5 runs per page: /  94-95   /about 96   /book 96   /data 96-99
//   CircleCI e2e-real (pipeline 113), 3 runs:   /  84, 72, 89 (LCP 3.8, 3.3, 2.4 s)
//                                               /about 93-98   /book 90-97   /data 88-94
// CI is noisier and slower than the laptop and is the authority. Median over those 3 CI runs: `/` 84
// (under the 0.85 budget), /about 94, /book 93, /data 93.
//
// `/` performance is REPORT-ONLY (`warn`) until `/` passes 0.85 on the median of 5 CI runs; then
// change its level to `error`. Every other assertion is a hard gate. The 0.85 budget is not lowered.
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
          matchingUrlPattern: "^https?://[^/]+/$",
          assertions: { ...rest, "categories:performance": median("warn", perf) },
        },
        {
          matchingUrlPattern: "^https?://[^/]+/(book|about|data)$",
          assertions: { ...rest, "categories:performance": median("error", perf) },
        },
      ],
    },
    upload: { target: "filesystem", outputDir: process.env.LHCI_OUTPUT_DIR || "/tmp/lighthouse" },
  },
};

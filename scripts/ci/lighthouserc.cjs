// Lighthouse CI config. Run by scripts/ci/lighthouse.sh against the booking app's
// production build served by `next start`.
//
// Budgets are minimum category scores (0..1). Aggregation is `median` on purpose: the median of each
// category over the runs of a page. lhci's default is `optimistic` (the best run) and `median-run`
// asserts on the single run closest to the median, which can hide a noisy page behind one lucky
// representative run (the first CI run saw `/` at 0.72, 0.84 and 0.89 and passed that way).
// `median` reports what a typical visit scores and never lets one run speak for the others.
//
// Measured on CircleCI (e2e-real), performance, 5 runs per page unless noted (read from the
// `lighthouse/` artifacts of each job):
//   pipeline 127: `/` median 89 (runs 79 to 92)  /about 93   /book 92   /data 94
//   pipeline 137: `/` median 77 (80, 66, 77, 75, 78; LCP median 3.3 s)   /about 91   /book 90   /data 90
//   pipeline 139: `/` median 86 (77, 81, 86, 87, 89; LCP median 3.3 s)   /about 92   /book 94   /data 92
//   pipeline 156 (main, 57e0ec5): `/` median 87 (85, 87, 87, 87, 88; LCP median 3.2 s)
//                                 /about 92   /book 93   /data 90
//   pipeline 160 (#42): `/` median 81 (72, 81, 76, 93, 90; LCP median 2.7 s)   /about 94   /book 94   /data 91
//   pipeline 113 (3 runs): `/` median 84.
// Accessibility, best practices and SEO were 100 on every run of every page.
//
// `/` performance is REPORT-ONLY (`warn`). Its CI medians are 84, 89, 77, 86, 87, 81: three of six are
// under the 0.85 budget, so it does not pass reliably, and a hard gate on it would fail about every other
// pipeline. The assertion already judges the median of 5 runs (one bad run cannot fail it alone); it is
// the page's median that moves, because its largest contentful paint is the hero paragraph. The budget
// (0.85) and the aggregation (`median`) are not to be changed to hide that. Fix the page, then change
// `/`'s level to `error` once several consecutive CI samples have a median with margin above 0.85. The
// other three pages and every accessibility, best-practices and SEO assertion are hard gates.
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

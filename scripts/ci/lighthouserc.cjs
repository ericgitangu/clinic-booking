// Lighthouse CI config (docs/adr/0026). Run by scripts/ci/lighthouse.sh against the booking app's
// production build served by `next start`. Budgets are minimum category scores (0..1) on the
// median of three runs. Measured on 2026-10-18 (Chrome, mobile preset, `next start` build, three
// runs per page): performance 94-100, accessibility 100, best practices 100, SEO 100 on all four
// pages. Accessibility, best practices and SEO sit 5 points under the measurement (docs/adr/0026 asks
// for at least 90 on accessibility and SEO); performance sits 9 under its lowest run because CI
// runners are slower and noisier than the machine it was measured on.
const base = process.env.LHCI_BASE_URL || "http://localhost:3100";
const paths = ["/", "/book", "/about", "/data"];
const budget = (key, fallback) => Number(process.env[key] || fallback);

module.exports = {
  ci: {
    collect: {
      url: paths.map((p) => `${base}${p}`),
      numberOfRuns: 3,
      settings: {
        // Lighthouse's default: mobile emulation with simulated slow 4G.
        chromeFlags: "--no-sandbox --headless=new",
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: budget("LH_MIN_PERFORMANCE", 0.85), aggregationMethod: "median-run" }],
        "categories:accessibility": ["error", { minScore: budget("LH_MIN_ACCESSIBILITY", 0.95), aggregationMethod: "median-run" }],
        "categories:best-practices": ["error", { minScore: budget("LH_MIN_BEST_PRACTICES", 0.95), aggregationMethod: "median-run" }],
        "categories:seo": ["error", { minScore: budget("LH_MIN_SEO", 0.95), aggregationMethod: "median-run" }],
      },
    },
    upload: { target: "filesystem", outputDir: process.env.LHCI_OUTPUT_DIR || ".lighthouseci" },
  },
};

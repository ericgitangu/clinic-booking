// Prints every Lighthouse run's category scores and the per-page median, from the report JSON files
// in a directory. The CI log is then the record of the numbers the budgets were judged on.
//   node summary.mjs <reports dir> [LCP handoff output file]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const runs = readdirSync(dir)
  .filter((f) => f.endsWith(".report.json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
if (runs.length === 0) {
  console.error(`no Lighthouse reports in ${dir}`);
  process.exit(1);
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const byPage = new Map();
for (const r of runs) {
  const path = new URL(r.finalDisplayedUrl ?? r.finalUrl).pathname;
  if (!byPage.has(path)) byPage.set(path, []);
  byPage.get(path).push(r);
}
const cats = ["performance", "accessibility", "best-practices", "seo"];
for (const [path, rs] of [...byPage].sort()) {
  console.log(`${path}  (${rs.length} runs)`);
  for (const c of cats) {
    const scores = rs.map((r) => Math.round(r.categories[c].score * 100));
    console.log(`  ${c.padEnd(15)} runs=${scores.join(",")} median=${median(scores)}`);
  }
  const lcp = rs.map((r) => Math.round(r.audits["largest-contentful-paint"].numericValue));
  console.log(`  ${"LCP ms".padEnd(15)} runs=${lcp.join(",")} median=${median(lcp)}`);
}

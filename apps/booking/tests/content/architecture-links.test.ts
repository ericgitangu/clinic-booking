import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allAnchors } from "@/content/architecture";

// Every in-repo pointer to a card on /architecture (the README, the apps, scripts and comments)
// must name an id the page defines, so renaming a card breaks this test and not a reader.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((f) => f !== "" && !f.startsWith("docs/"))
  .filter((f) => !f.endsWith("architecture-links.test.ts"))
  .filter((f) => existsSync(`${root}/${f}`))
  .filter((f) => !/\.(png|webp|ico|jpg|jpeg|gif|woff2?|pdf|svg|lock)$/.test(f))
  .filter((f) => !f.endsWith("pnpm-lock.yaml"));

const found: { file: string; id: string }[] = [];
const link = /\/architecture#([a-z0-9-]+)/g;
for (const f of tracked) {
  const body = readFileSync(`${root}/${f}`, "utf8");
  for (const m of body.matchAll(link)) found.push({ file: f, id: m[1]! });
}

describe("architecture page links", () => {
  it("every /architecture#id in the repo names an anchor on the page", () => {
    const ids = new Set(allAnchors());
    expect(found.filter((x) => !ids.has(x.id))).toEqual([]);
  });

  it("the README links into the page", () => {
    expect(found.some((x) => x.file === "README.md")).toBe(true);
  });
});

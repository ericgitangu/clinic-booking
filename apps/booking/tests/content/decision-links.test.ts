import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allAnchors } from "@/content/architecture";
import { DECISIONS } from "@/content/decisions";

// Every in-repo pointer to a decision goes to /decisions#<id>. These checks read the tracked tree,
// so a link to an entry that was renamed, or a path into the docs/ folder (not in the repository), fails.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// Paths a reviewer cannot open: files under docs/ are not in the repository. The hygiene self-test
// and the hygiene rule name such paths on purpose, as fixtures and as a pattern for its detectors.
const NOT_IN_REPO = /(?<![\w./:@-])docs\/[\w-]+(\/|\.md)/;
const FIXTURES = new Set([
  "scripts/repo_hygiene.sh",
  "scripts/repo_hygiene_selftest.sh",
]);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f !== "")
  .filter((f) => existsSync(`${root}/${f}`)) // listed but deleted in the working tree
  .filter((f) => !/\.(png|webp|ico|jpg|jpeg|gif|woff2?|pdf)$/.test(f));

const text = new Map<string, string>(
  tracked.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")]),
);

describe("decision links", () => {
  it("no tracked file points into the docs folder, which is not in the repository", () => {
    const hits = [...text]
      .filter(([f, body]) => !FIXTURES.has(f) && NOT_IN_REPO.test(body))
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it("every decisions-page anchor link in the repo names an entry in decisions.ts or a tab, card or record on the page", () => {
    const ids = new Set([...DECISIONS.map((d) => d.id), ...allAnchors()]);
    const link = new RegExp("/decisions#([a-z0-9-]+)", "g");
    const found: { file: string; id: string }[] = [];
    for (const [file, body] of text)
      for (const m of body.matchAll(link)) found.push({ file, id: m[1]! });
    expect(found.length).toBeGreaterThan(10); // not vacuous: README, docs, scripts and the app all link
    const missing = found.filter((x) => !ids.has(x.id));
    expect(missing).toEqual([]);
  });
});

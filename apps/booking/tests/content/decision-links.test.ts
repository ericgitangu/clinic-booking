import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECISIONS } from "@/content/decisions";

// Every in-repo pointer to a decision goes to /decisions#<id>. These checks read the tracked tree,
// so a link to an entry that was renamed, or a path into the removed decision-record folder, fails.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const FOLDER = ["docs", "adr"].join("/"); // built from parts so this file does not contain it
const RECORDS = `${FOLDER}/`;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f !== "" && !f.startsWith(RECORDS))
  .filter((f) => existsSync(`${root}/${f}`)) // listed but deleted in the working tree
  .filter((f) => !/\.(png|webp|ico|jpg|jpeg|gif|woff2?|pdf)$/.test(f));

const text = new Map<string, string>(
  tracked.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")]),
);

describe("decision links", () => {
  it("no tracked file outside the record folder points into it", () => {
    // the folder path, or a relative link to a numbered record file ("adr/0003-...md")
    const relative = new RegExp(`(^|[^a-z])adr/\\d{4}-[a-z0-9-]+\\.md`);
    const hits = [...text]
      .filter(([, body]) => body.includes(FOLDER) || relative.test(body))
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it("every decisions-page anchor link in the repo names an entry in decisions.ts", () => {
    const ids = new Set(DECISIONS.map((d) => d.id));
    const link = new RegExp("/decisions#([a-z0-9-]+)", "g");
    const found: { file: string; id: string }[] = [];
    for (const [file, body] of text)
      for (const m of body.matchAll(link)) found.push({ file, id: m[1]! });
    expect(found.length).toBeGreaterThan(10); // not vacuous: README, docs, scripts and the app all link
    const missing = found.filter((x) => !ids.has(x.id));
    expect(missing).toEqual([]);
  });
});

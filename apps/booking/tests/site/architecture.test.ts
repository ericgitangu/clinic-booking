import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DECISIONS, DIAGRAM_LABEL, GO_NOTE } from "@/lib/architecture";

// The README and the landing page carry the same architecture; these tests fail if they drift.
const root = (p: string) =>
  fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const readme = readFileSync(root("README.md"), "utf8");
const section = readme.slice(
  readme.indexOf("\n## Architecture\n"),
  readme.indexOf("\n## 1. Live URLs"),
);
const mmd = readFileSync(root("docs/architecture/architecture.mmd"), "utf8");

describe("the architecture section matches the landing page", () => {
  it("has the same table, row for row", () => {
    const rows = section
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Component"))
      .map((l) => l.slice(2, -2).split(" | "));
    expect(rows).toHaveLength(DECISIONS.length);
    rows.forEach((cells, i) => {
      const d = DECISIONS[i]!;
      expect(cells[0]).toBe(d.component);
      expect(cells[1]).toBe(d.choice);
      expect(cells[2]).toBe(d.why);
    });
  });

  it("carries the same Mermaid source as the rendered SVGs came from", () => {
    const block = /```mermaid\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block?.trimEnd()).toBe(mmd.trimEnd());
  });

  it("states Go the same way in both places, word for word", () => {
    expect(readme).toContain(`${GO_NOTE.statement} ${GO_NOTE.reason}`);
    expect(GO_NOTE.reason).toContain("about 900 vCPU-s per connected hour");
    expect(GO_NOTE.reason).toContain("per instance");
  });

  it("ships both renderings: every label of the source, no script, a title and a description", () => {
    // Every quoted node or edge label, split on the line breaks Mermaid turns into tspans.
    const labels = [...mmd.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1]!)
      .flatMap((l) => l.split("<br/>"))
      .map((l) => l.trim())
      .filter(Boolean);
    expect(labels.length).toBeGreaterThan(20);
    for (const theme of ["light", "dark"]) {
      const svg = readFileSync(
        fileURLToPath(
          new URL(`../../public/architecture-${theme}.svg`, import.meta.url),
        ),
        "utf8",
      );
      expect(svg).toMatch(/^<svg /);
      expect(svg).not.toMatch(/<script|onload=|<foreignObject/i);
      expect(svg).toMatch(/<title[^>]*>Idyllic Clinic architecture<\/title>/);
      expect(svg).toMatch(/<desc[^>]*>[^<]{80,}<\/desc>/);
      const text = svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      for (const l of labels) {
        // Word by word, so a label the renderer wrapped onto several lines still matches.
        for (const w of l.split(/\s+/)) {
          const plain = w.replace(/^[("]+|[,.;:)"]+$/g, "");
          if (plain.length > 2) expect(text, `${theme}: ${l}`).toContain(plain);
        }
      }
    }
    expect(DIAGRAM_LABEL.length).toBeGreaterThan(100);
  });
});

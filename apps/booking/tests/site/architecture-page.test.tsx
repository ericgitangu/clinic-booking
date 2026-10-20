import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ArchitecturePage from "@/app/architecture/page";
import { highlight } from "@/components/architecture/highlight";
import { Inline, parseInline } from "@/components/architecture/inline";
import { ADRS, TABS } from "@/content/architecture";

const html = renderToStaticMarkup(<ArchitecturePage />);

describe("the architecture page as served", () => {
  it("has six tabs, each controlling a panel that is in the HTML", () => {
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(tabs).toHaveLength(6);
    for (const t of TABS) {
      expect(html).toContain(`aria-controls="${t.id}"`);
      expect(html).toMatch(
        new RegExp(`<section id="${t.id}"[^>]*role="tabpanel"`),
      );
    }
  });

  it("shows the first panel and hides the rest until a script chooses, with a no-script rule to show all", () => {
    const panels = [
      ...html.matchAll(/<section id="[^"]+"[^>]*role="tabpanel"[^>]*>/g),
    ].map((m) => m[0]);
    expect(panels).toHaveLength(6);
    expect(panels[0]).not.toContain("data-off");
    for (const p of panels.slice(1)) expect(p).toContain('data-off=""');
    expect(html).toContain("<noscript>");
    expect(html).toContain('[role="tabpanel"][data-off]{display:block}');
  });

  it("only the selected tab is in the tab order", () => {
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(tabs.filter((t) => t.includes('tabindex="0"'))).toHaveLength(1);
    expect(tabs.filter((t) => t.includes('tabindex="-1"'))).toHaveLength(5);
    expect(tabs[0]).toContain('aria-selected="true"');
  });

  it("renders every record card with its four parts, even in hidden panels", () => {
    for (const a of ADRS) expect(html).toContain(`id="${a.id}"`);
    expect(html.match(/<dt[^>]*>What I decided/g)).toHaveLength(ADRS.length);
    expect(html.match(/<dt[^>]*>What it cost/g)).toHaveLength(ADRS.length);
    expect(html.match(/<dt[^>]*>When I would revisit it/g)).toHaveLength(
      ADRS.length,
    );
  });

  it("carries no inline script of its own", () => {
    expect(html).not.toContain("<script");
  });
});

describe("inline marks", () => {
  it("reads code, bold and links, and leaves other text alone", () => {
    expect(parseInline("a `b` **c** [d](#e) f")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b" },
      { kind: "text", text: " " },
      { kind: "bold", text: "c" },
      { kind: "text", text: " " },
      { kind: "link", text: "d", href: "#e" },
      { kind: "text", text: " f" },
    ]);
  });

  it("escapes markup in text and marks external links as new-tab links", () => {
    const out = renderToStaticMarkup(
      <Inline text={"<img src=x> [x](https://example.com)"} />,
    );
    expect(out).toContain("&lt;img src=x&gt;");
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe("code highlighting", () => {
  it("marks flags, strings and comments in shell, and keys in JSON", () => {
    const sh = highlight(
      "bash",
      'gcloud run deploy --region x # note\necho "hi"',
    );
    expect(sh.filter((t) => t.kind === "flag").map((t) => t.text)).toEqual([
      "--region",
    ]);
    expect(sh.some((t) => t.kind === "comment")).toBe(true);
    expect(sh.some((t) => t.kind === "string" && t.text === '"hi"')).toBe(true);
    const js = highlight("json", '{"a": "b", "c": true}');
    expect(js.find((t) => t.kind === "key")?.text).toBe('"a"');
    expect(js.find((t) => t.kind === "keyword")?.text).toBe("true");
  });

  it("gives back the same text it was given", () => {
    for (const [lang, code] of [
      ["bash", 'a -b --c="d" # e\n$X'],
      ["sql", "SELECT 1 -- x\nFROM t WHERE a = 'b''c';"],
      ["text", "plain <text>"],
    ] as const)
      expect(
        highlight(lang, code)
          .map((t) => t.text)
          .join(""),
      ).toBe(code);
  });
});

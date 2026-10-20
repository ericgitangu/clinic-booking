import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DecisionsPage from "@/app/decisions/page";
import { GET, generateStaticParams } from "@/app/decisions/panel/[id]/route";
import { highlight } from "@/components/architecture/highlight";
import { Inline, parseInline } from "@/components/architecture/inline";
import { ADRS, TABS } from "@/content/architecture";
import { DECISIONS } from "@/content/decisions";

const html = renderToStaticMarkup(<DecisionsPage />);
const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(
  (m) => m[0],
);
const panels = [...html.matchAll(/<section[^>]*role="tabpanel"[^>]*>/g)].map(
  (m) => m[0],
);

describe("the decisions page as served", () => {
  it("has seven tabs, each controlling a panel that is in the HTML", () => {
    expect(tabs).toHaveLength(7);
    expect(panels).toHaveLength(7);
    for (const t of TABS) {
      expect(html).toContain(`aria-controls="${t.id}"`);
      expect(html).toMatch(
        new RegExp(`<section[^>]*id="${t.id}"[^>]*role="tabpanel"`),
      );
    }
  });

  it("carries the ten decisions on the first load and nothing from the other tabs", () => {
    expect(html.match(/<article /g)).toHaveLength(DECISIONS.length);
    for (const d of DECISIONS) expect(html).toContain(`id="${d.id}"`);
    expect(html).not.toContain('id="adr-0003"');
    expect(html).not.toContain('id="rollback"');
  });

  it("shows the first panel, and the others load on demand with a plain-page fallback", () => {
    expect(panels[0]).not.toContain("data-off");
    for (const p of panels.slice(1)) {
      expect(p).toContain('data-off=""');
      expect(p).toMatch(/data-src="\/decisions\/panel\/[a-z]+"/);
    }
    expect(html).toContain("<noscript>");
    expect(html).toContain('[role="tabpanel"][data-off]{display:block}');
    expect(html).toContain("as a plain page");
  });

  it("only the selected tab is in the tab order", () => {
    expect(tabs.filter((t) => t.includes('tabindex="0"'))).toHaveLength(1);
    expect(tabs.filter((t) => t.includes('tabindex="-1"'))).toHaveLength(6);
    expect(tabs[0]).toContain('aria-selected="true"');
  });

  it("carries no inline script of its own", () => {
    expect(html).not.toContain("<script");
  });
});

describe("the tab fragments", () => {
  it("builds one for every tab but the first", () => {
    expect(generateStaticParams().map((p) => p.id)).toEqual(
      TABS.slice(1).map((t) => t.id),
    );
  });

  it("renders every record card with its four parts", async () => {
    const res = await GET(new Request("http://x/decisions/panel/record"), {
      params: Promise.resolve({ id: "record" }),
    });
    const doc = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(doc).toContain("noindex");
    expect(doc).toContain("data-fragment");
    for (const a of ADRS) expect(doc).toContain(`id="${a.id}"`);
    expect(doc.match(/<dt[^>]*>What I decided/g)).toHaveLength(ADRS.length);
    expect(doc.match(/<dt[^>]*>What it cost/g)).toHaveLength(ADRS.length);
    expect(doc.match(/<dt[^>]*>When I would revisit it/g)).toHaveLength(
      ADRS.length,
    );
    expect(doc).not.toContain("<script");
  });

  it("answers 404 for a tab that does not exist", async () => {
    const res = await GET(new Request("http://x/decisions/panel/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
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

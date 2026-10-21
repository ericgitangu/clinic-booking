import { describe, expect, it } from "vitest";
import { DECISIONS } from "@/content/decisions";
import {
  DECISION_CARDS,
  CARD_TABS,
  RECORD_TAB,
  TABS,
  allAnchors,
} from "@/content/architecture";
import { DECISION_INTRO, DECISION_STATUS_NOTE } from "@/content/architecture";
import { linkTargets } from "@/components/architecture/inline";
import type { Block } from "@/content/architecture/types";

const SITE_PATHS = new Set(["/docs", "/redoc", "/openapi.json", "/decisions"]);

/** Every string in the content that may carry inline marks. */
function strings(): string[] {
  const out: string[] = [DECISION_INTRO, DECISION_STATUS_NOTE];
  const block = (b: Block) => {
    switch (b.t) {
      case "p":
      case "note":
        out.push(b.text);
        break;
      case "ul":
      case "ol":
        out.push(...b.items);
        break;
      case "table":
        out.push(b.caption, ...b.head, ...b.rows.flat());
        break;
      case "facts":
        out.push(...b.items.flatMap((f) => [f.label, f.value]));
        break;
      case "code":
        out.push(b.caption ?? "");
        break;
      default:
    }
  };
  for (const a of DECISION_CARDS)
    out.push(a.title, a.status, a.decision, a.cost, a.revisit);
  for (const t of CARD_TABS) {
    out.push(t.intro, t.label);
    for (const c of t.cards) {
      out.push(c.title, c.summary ?? "");
      c.blocks.forEach(block);
    }
  }
  return out;
}

describe("decision record cards", () => {
  it("never says ADR to the reader", () => {
    const text = JSON.stringify([strings(), DECISION_CARDS]);
    expect(text).not.toMatch(/\bADRs?\b|adr-\d/i);
  });

  it("has one card for every decision, 1 to 35, in order", () => {
    expect(DECISION_CARDS).toHaveLength(35);
    expect(DECISION_CARDS.map((a) => a.number)).toEqual(
      Array.from({ length: 35 }, (_, i) => String(i + 1)),
    );
    expect(DECISION_CARDS.map((a) => a.id)).toEqual(
      DECISION_CARDS.map((a) => `decision-${a.number}`),
    );
  });

  it("gives every card its title, status, decision, cost and revisit trigger", () => {
    for (const a of DECISION_CARDS) {
      for (const f of [
        "title",
        "status",
        "decision",
        "cost",
        "revisit",
      ] as const)
        expect(a[f].trim(), `${a.id}.${f}`).not.toBe("");
    }
  });

  it("only points at decisions-page entries and cards that exist", () => {
    const decisionIds = new Set(DECISIONS.map((d) => d.id));
    const anchors = new Set(allAnchors());
    for (const a of DECISION_CARDS) {
      for (const id of a.decisionsPage ?? [])
        expect(decisionIds.has(id), `${a.id} -> /decisions#${id}`).toBe(true);
      for (const id of a.related ?? [])
        expect(anchors.has(id), `${a.id} related ${id}`).toBe(true);
    }
  });
});

describe("page anchors", () => {
  it("are unique, lower-case and dashed, and none reuses a decision's anchor", () => {
    const all = [...allAnchors(), ...DECISIONS.map((d) => d.id)];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("include the anchors other files cite for runbooks and the Go gateway", () => {
    const anchors = new Set(allAnchors());
    for (const id of [
      "neon",
      "bootstrap",
      "base-image-cve",
      "rollback",
      "go-gateway",
      "api-collection",
    ])
      expect(anchors.has(id), id).toBe(true);
  });

  it("names the seven tabs in order", () => {
    expect(TABS.map((t) => t.label)).toEqual([
      "Decisions",
      "Decision record",
      "Architecture",
      "Operations",
      "Evidence",
      "API and collections",
      "Screenshots",
    ]);
    expect(TABS[1]!.id).toBe(RECORD_TAB.id);
  });

  it("every card has a title and at least one block", () => {
    for (const t of CARD_TABS)
      for (const c of t.cards) {
        expect(c.title.trim(), c.id).not.toBe("");
        expect(c.blocks.length, c.id).toBeGreaterThan(0);
      }
  });
});

describe("content links and wording", () => {
  const all = strings();

  it("every link resolves: a card, a decisions entry, a site page or https", () => {
    const anchors = new Set(allAnchors());
    const decisionIds = new Set(DECISIONS.map((d) => d.id));
    const bad: string[] = [];
    for (const s of all)
      for (const href of linkTargets(s)) {
        if (href.startsWith("#")) {
          if (!anchors.has(href.slice(1))) bad.push(href);
        } else if (href.startsWith("/decisions#")) {
          if (!decisionIds.has(href.slice("/decisions#".length)))
            bad.push(href);
        } else if (href.startsWith("https://")) {
          // external
        } else if (!SITE_PATHS.has(href)) bad.push(href);
      }
    expect(bad).toEqual([]);
  });

  it("uses no dashes as punctuation, and no pointer into the removed docs folder", () => {
    for (const s of all) {
      expect(s).not.toMatch(/[–—]/);
      expect(s).not.toMatch(/docs\/[\w-]+(\/|\.md)/);
    }
  });

  it("has no raw HTML in prose", () => {
    for (const s of all)
      expect(s).not.toMatch(
        /<\/?(script|style|img|a|div|span|iframe|svg|b|i|p|br|em|strong)[\s>/]/i,
      );
  });
});

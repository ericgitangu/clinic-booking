import { DECISION_CARDS_1 } from "./decision-cards-1";
import { DECISION_CARDS_2 } from "./decision-cards-2";
import {
  DECISION_CARDS_3,
  DECISION_INTRO,
  DECISION_STATUS_NOTE,
} from "./decision-cards-3";
import { API } from "./api";
import { EVIDENCE } from "./evidence";
import { OPERATIONS } from "./operations";
import { OVERVIEW } from "./overview";
import { SCREENSHOTS } from "./screenshots";
import type { DecisionCard, Card, TabContent } from "./types";

export { DECISION_INTRO, DECISION_STATUS_NOTE };

export const PAGE_INTRO =
  "The other tabs hold the rest of the working: the full set of 34 numbered decisions, how the system fits together, how it is run, what I observed on the live stack, and how to call the API.";

export const DECISION_CARDS: readonly DecisionCard[] = [
  ...DECISION_CARDS_1,
  ...DECISION_CARDS_2,
  ...DECISION_CARDS_3,
];

export const SCREENSHOTS_TAB: TabContent = {
  id: "screenshots",
  label: "Screenshots",
  intro:
    "Only pictures that match the interface on main are shown. Each has a light and a dark version; the page serves the one that matches your colour scheme.",
  cards: SCREENSHOTS.map((s): Card => ({
    id: `shot-${s.id}`,
    title: s.title,
    summary: `Taken ${s.taken}`,
    date: s.taken,
    blocks: [{ t: "image", id: s.id }],
  })),
};

/** The first tab is the decisions page's own ten entries, rendered by the page itself. */
export const DECISIONS_TAB = { id: "decisions", label: "Decisions" } as const;

/** The records tab has its own card type, so it carries no `cards`. */
export const RECORD_TAB = { id: "record", label: "Decision record" } as const;

export type TabId =
  | "decisions"
  | "record"
  | "architecture"
  | "operations"
  | "evidence"
  | "api"
  | "screenshots";

export const TABS: readonly { id: TabId; label: string }[] = [
  DECISIONS_TAB,
  RECORD_TAB,
  { id: OVERVIEW.id as TabId, label: OVERVIEW.label },
  { id: OPERATIONS.id as TabId, label: OPERATIONS.label },
  { id: EVIDENCE.id as TabId, label: EVIDENCE.label },
  { id: API.id as TabId, label: API.label },
  { id: SCREENSHOTS_TAB.id as TabId, label: SCREENSHOTS_TAB.label },
];

export const CARD_TABS: readonly TabContent[] = [
  OVERVIEW,
  OPERATIONS,
  EVIDENCE,
  API,
  SCREENSHOTS_TAB,
];

/** Card id to the tab that holds it, for every card that is loaded on demand. */
export function cardTabs(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of CARD_TABS) for (const c of t.cards) map[c.id] = t.id;
  for (const a of DECISION_CARDS) map[a.id] = RECORD_TAB.id;
  return map;
}

/** Every anchor id the page defines on top of the ten decisions: tabs, cards and records. */
export function allAnchors(): string[] {
  return [
    ...TABS.map((t) => t.id),
    ...CARD_TABS.flatMap((t) => t.cards.map((c) => c.id)),
    ...DECISION_CARDS.map((a) => a.id),
  ];
}

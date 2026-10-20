import { ADRS_1 } from "./adrs-1";
import { ADRS_2 } from "./adrs-2";
import { ADRS_3, ADR_INTRO, ADR_STATUS_NOTE } from "./adrs-3";
import { API } from "./api";
import { EVIDENCE } from "./evidence";
import { OPERATIONS } from "./operations";
import { OVERVIEW } from "./overview";
import { SCREENSHOTS } from "./screenshots";
import type { AdrCard, Card, TabContent } from "./types";

export { ADR_INTRO, ADR_STATUS_NOTE };

export const PAGE_INTRO =
  "Everything a reviewer needs beyond the README: how the system fits together, why each choice was made, how it is run, what I observed on the live stack and how to call the API.";

export const ADRS: readonly AdrCard[] = [...ADRS_1, ...ADRS_2, ...ADRS_3];

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

/** The records tab has its own card type, so it carries no `cards`. */
export const RECORD_TAB = {
  id: "decisions-record",
  label: "Decisions record",
} as const;

export const TABS: readonly { id: string; label: string }[] = [
  { id: OVERVIEW.id, label: OVERVIEW.label },
  RECORD_TAB,
  { id: OPERATIONS.id, label: OPERATIONS.label },
  { id: EVIDENCE.id, label: EVIDENCE.label },
  { id: API.id, label: API.label },
  { id: SCREENSHOTS_TAB.id, label: SCREENSHOTS_TAB.label },
];

export const CARD_TABS: readonly TabContent[] = [
  OVERVIEW,
  OPERATIONS,
  EVIDENCE,
  API,
  SCREENSHOTS_TAB,
];

/** Every anchor id the page defines: tabs, cards and records. */
export function allAnchors(): string[] {
  return [
    ...TABS.map((t) => t.id),
    ...CARD_TABS.flatMap((t) => t.cards.map((c) => c.id)),
    ...ADRS.map((a) => a.id),
  ];
}

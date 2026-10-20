// The shapes behind the /architecture page. Content files export typed data; the page only lays it
// out. Strings that say "text" below may use three inline marks and nothing else:
//   `code`            monospace
//   **bold**          bold
//   [label](target)   a link. target is "#anchor" (a card on this page), "/decisions#id" (the
//                     decisions page), another site path like "/docs", or an https:// address.
// No raw HTML. A unit test checks every link target resolves.

export type Block =
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | {
      t: "code";
      lang: "bash" | "json" | "sql" | "text";
      code: string;
      caption?: string;
    }
  | { t: "table"; caption: string; head: string[]; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "facts"; items: { label: string; value: string }[] }
  | { t: "diagram"; id: DiagramId }
  | { t: "image"; id: string };

export type DiagramId =
  | "context"
  | "containers"
  | "booking-flow"
  | "slot-push"
  | "release-pipeline"
  | "architecture";

/** One expandable card with an anchor id. */
export type Card = {
  /** Lower-case, dashes. Unique across the whole page. It is the URL fragment. */
  id: string;
  title: string;
  /** One line shown under the title while the card is closed. */
  summary?: string;
  /** A date in YYYY-MM-DD, for observations. */
  date?: string;
  blocks: Block[];
};

/** A decision record card. All four parts are required. */
export type AdrCard = {
  /** "adr-0003": the anchor. */
  id: string;
  /** "0003". */
  number: string;
  title: string;
  /** Accepted, or what replaced or narrowed it. Plain words. */
  status: string;
  /** What I decided, in my own words. */
  decision: string;
  /** What it cost me or what I gave up. */
  cost: string;
  /** What would make me look at it again. */
  revisit: string;
  /** Ids on the /decisions page that cover the same choice, if any. */
  decisionsPage?: string[];
  /** Other cards on this page worth reading with it, as card ids ("adr-0031"). */
  related?: string[];
};

export type TabContent = {
  id: string;
  label: string;
  /** Two sentences at most, under the tab heading. */
  intro: string;
  cards: Card[];
};

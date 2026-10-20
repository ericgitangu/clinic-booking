import {
  DECISION_CARDS,
  DECISION_INTRO,
  DECISION_STATUS_NOTE,
  CARD_TABS,
  RECORD_TAB,
} from "@/content/architecture";
import { InfoCard, RecordCard } from "./card";
import { Inline } from "./inline";

/** The heading, intro and cards of one tab other than the decisions tab. */
export function PanelBody({ tabId, label }: { tabId: string; label: string }) {
  const record = tabId === RECORD_TAB.id;
  const tab = CARD_TABS.find((t) => t.id === tabId);
  const intro = record
    ? `${DECISION_INTRO} ${DECISION_STATUS_NOTE}`
    : (tab?.intro ?? "");
  return (
    <>
      <h2 className="font-heading text-2xl font-semibold tracking-tight">
        {label}
      </h2>
      <p className="mt-2 max-w-[65ch] text-base leading-7 text-muted-foreground">
        <Inline text={intro} />
      </p>
      <div className="mt-6 space-y-3">
        {record
          ? DECISION_CARDS.map((a) => <RecordCard key={a.id} card={a} />)
          : tab?.cards.map((c, n) => (
              <InfoCard key={c.id} card={c} open={n === 0} />
            ))}
      </div>
    </>
  );
}

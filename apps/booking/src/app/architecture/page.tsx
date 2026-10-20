import type { Metadata } from "next";
import { InfoCard, RecordCard } from "@/components/architecture/card";
import { Inline } from "@/components/architecture/inline";
import { TabBar } from "@/components/architecture/tab-bar";
import {
  ADRS,
  ADR_INTRO,
  ADR_STATUS_NOTE,
  CARD_TABS,
  PAGE_INTRO,
  RECORD_TAB,
  TABS,
} from "@/content/architecture";
import { pageMetadata } from "@/lib/metadata";
import { SITE } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Architecture",
  description: `How ${SITE.name} fits together, the decision record, how it is run, what I observed on the live stack and how to call the API.`,
  path: "/architecture",
});
export const dynamic = "force-static";

const H2 = "font-heading text-2xl font-semibold tracking-tight";
// Server-rendered panels. Only the first is visible in the HTML; the tab bar shows the one the
// address names. The <noscript> rule below shows all of them when scripts are off.
const PANEL =
  "mt-8 scroll-mt-24 focus-visible:outline-2 focus-visible:outline-ring";

function Panel({
  id,
  label,
  intro,
  first,
  children,
}: {
  id: string;
  label: string;
  intro: string;
  first: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      role="tabpanel"
      aria-labelledby={`tab-${id}`}
      tabIndex={-1}
      data-off={first ? undefined : ""}
      className={PANEL}
    >
      <h2 className={H2}>{label}</h2>
      <p className="mt-2 max-w-[65ch] text-base leading-7 text-muted-foreground">
        <Inline text={intro} />
      </p>
      <div className="mt-6 space-y-3">{children}</div>
    </section>
  );
}

export default function ArchitecturePage() {
  const byId = new Map(CARD_TABS.map((t) => [t.id, t]));
  return (
    <div className="py-12">
      <noscript>
        <style>{`[role="tabpanel"][data-off]{display:block}[role="tablist"],[data-tab-extra]{display:none}`}</style>
      </noscript>
      <header className="max-w-[65ch]">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          Architecture
        </h1>
        <p className="mt-4 text-lg leading-8">{PAGE_INTRO}</p>
        <p className="mt-3 text-base text-muted-foreground">
          The ten choices I would defend in a review are on the{" "}
          <a
            href="/decisions"
            className="rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
          >
            decisions page
          </a>
          . The full record is the second tab here.
        </p>
      </header>

      <div className="mt-8">
        <TabBar tabs={TABS} />
      </div>

      {TABS.map((t, i) => {
        if (t.id === RECORD_TAB.id) {
          return (
            <Panel
              key={t.id}
              id={t.id}
              label={t.label}
              intro={`${ADR_INTRO} ${ADR_STATUS_NOTE}`}
              first={i === 0}
            >
              {ADRS.map((a) => (
                <RecordCard key={a.id} adr={a} />
              ))}
            </Panel>
          );
        }
        const tab = byId.get(t.id)!;
        return (
          <Panel
            key={t.id}
            id={t.id}
            label={tab.label}
            intro={tab.intro}
            first={i === 0}
          >
            {tab.cards.map((c, n) => (
              <InfoCard key={c.id} card={c} open={n === 0} />
            ))}
          </Panel>
        );
      })}
    </div>
  );
}

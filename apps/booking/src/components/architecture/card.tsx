import { ChevronDown } from "lucide-react";
import type { AdrCard, Card } from "@/content/architecture/types";
import { Blocks } from "./blocks";
import { Inline } from "./inline";

const SUMMARY =
  "flex min-h-14 cursor-pointer list-none items-start gap-3 px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 rounded-xl";
const CHEVRON =
  "mt-1.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none";
const LABEL = "font-heading text-sm font-semibold text-foreground";

export function InfoCard({ card, open }: { card: Card; open?: boolean }) {
  return (
    <details
      id={card.id}
      data-card
      open={open}
      className="group scroll-mt-24 rounded-xl border border-border bg-card text-card-foreground"
    >
      <summary className={SUMMARY}>
        <span className="min-w-0 flex-1">
          <h3 className="font-heading text-lg leading-snug font-semibold">
            {card.title}
          </h3>
          {card.summary ? (
            <span className="mt-0.5 block text-sm text-muted-foreground">
              {card.summary}
            </span>
          ) : null}
        </span>
        <ChevronDown aria-hidden="true" className={CHEVRON} />
      </summary>
      <div className="border-t border-border px-4 py-5 sm:px-5">
        <Blocks blocks={card.blocks} />
      </div>
    </details>
  );
}

export function RecordCard({ adr }: { adr: AdrCard }) {
  return (
    <details
      id={adr.id}
      data-card
      className="group scroll-mt-24 rounded-xl border border-border bg-card text-card-foreground"
    >
      <summary className={SUMMARY}>
        <span
          aria-hidden="true"
          className="w-11 shrink-0 pt-0.5 font-heading text-xl font-semibold text-primary"
        >
          {adr.number}
        </span>
        <span className="min-w-0 flex-1">
          <h3 className="font-heading text-lg leading-snug font-semibold">
            <span className="sr-only">Decision {adr.number}: </span>
            {adr.title}
          </h3>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {adr.status}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className={CHEVRON} />
      </summary>
      <dl className="grid border-t border-border md:grid-cols-2">
        <div className="border-l-4 border-primary px-4 py-4 sm:px-5 md:col-span-2">
          <dt className={LABEL}>What I decided</dt>
          <dd className="mt-1 max-w-[68ch] leading-7">
            <Inline text={adr.decision} />
          </dd>
        </div>
        <div className="border-t border-border bg-muted px-4 py-4 sm:px-5 md:rounded-bl-xl">
          <dt className={LABEL}>What it cost</dt>
          <dd className="mt-1 leading-7">
            <Inline text={adr.cost} />
          </dd>
        </div>
        <div className="border-t border-border px-4 py-4 sm:px-5 md:border-l">
          <dt className={LABEL}>When I would revisit it</dt>
          <dd className="mt-1 leading-7">
            <Inline text={adr.revisit} />
          </dd>
        </div>
        <div className="border-t border-border px-4 py-3 text-sm md:col-span-2 sm:px-5">
          <dt className="sr-only">Status</dt>
          <dd className="text-muted-foreground">
            Status: {adr.status}.
            {adr.decisionsPage?.length ? (
              <>
                {" "}
                In plain words on the{" "}
                {adr.decisionsPage.map((id, i) => (
                  <span key={id}>
                    {i > 0 ? ", " : ""}
                    <a
                      href={`/decisions#${id}`}
                      className="rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      decisions page
                      {adr.decisionsPage!.length > 1 ? ` (${id})` : ""}
                    </a>
                  </span>
                ))}
                .
              </>
            ) : null}
            {adr.related?.length ? (
              <>
                {" "}
                Read with{" "}
                {adr.related.map((id, i) => (
                  <span key={id}>
                    {i > 0 ? ", " : ""}
                    <a
                      href={`#${id}`}
                      className="rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {id.replace("adr-", "")}
                    </a>
                  </span>
                ))}
                .
              </>
            ) : null}
          </dd>
        </div>
      </dl>
    </details>
  );
}

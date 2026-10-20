import type { Metadata } from "next";
import {
  DECISIONS,
  DECISIONS_DRAFT,
  DECISIONS_INTRO,
  type Decision,
} from "@/content/decisions";
import { pageMetadata } from "@/lib/metadata";
import { SITE } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Architecture decisions",
  description: `The choices behind ${SITE.name}: what I picked, what it cost me, why, and when I would revisit it.`,
  path: "/decisions",
});
export const dynamic = "force-static";

const LABEL = "font-heading text-sm font-semibold text-foreground";

function Entry({ d }: { d: Decision }) {
  return (
    <article
      id={d.id}
      aria-labelledby={`${d.id}-title`}
      className="scroll-mt-24 rounded-xl border border-border bg-card text-card-foreground"
    >
      <h2
        id={`${d.id}-title`}
        className="border-b border-border px-5 pt-5 pb-4 font-heading text-xl font-semibold tracking-tight sm:px-7 sm:text-2xl"
      >
        {d.title}
      </h2>
      {d.placeholder ? (
        <p className="px-5 py-6 text-base text-muted-foreground sm:px-7">
          {d.decision}
        </p>
      ) : (
        <dl className="grid md:grid-cols-3">
          <div className="border-l-4 border-primary px-5 py-5 sm:px-7 md:col-span-3">
            <dt className={LABEL}>What I chose</dt>
            <dd className="mt-1.5 max-w-[68ch] text-lg leading-8">
              {d.decision}
            </dd>
          </div>
          <div className="border-t border-border bg-muted px-5 py-5 sm:px-7 md:rounded-bl-xl">
            <dt className={LABEL}>What I gave up</dt>
            <dd className="mt-1.5 leading-7">{d.gaveUp}</dd>
          </div>
          <div className="border-t border-border px-5 py-5 sm:px-7 md:border-l">
            <dt className={LABEL}>Why</dt>
            <dd className="mt-1.5 leading-7">{d.why}</dd>
          </div>
          <div className="border-t border-border px-5 py-5 sm:px-7 md:border-l">
            <dt className={LABEL}>When I would revisit it</dt>
            <dd className="mt-1.5 leading-7">{d.revisit}</dd>
          </div>
        </dl>
      )}
    </article>
  );
}

export default function DecisionsPage() {
  return (
    <div className="py-12">
      <header className="max-w-[65ch]">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          Architecture decisions
        </h1>
        <p className="mt-4 text-lg leading-8">{DECISIONS_INTRO}</p>
        {DECISIONS_DRAFT ? (
          <p
            data-testid="draft-banner"
            className="mt-6 rounded-md border border-border bg-accent px-4 py-3 text-sm text-accent-foreground"
          >
            Draft pending the engineer&apos;s edit
          </p>
        ) : null}
      </header>

      <nav aria-label="Decisions on this page" className="mt-10">
        <ul className="grid gap-x-8 sm:grid-cols-2">
          {DECISIONS.map((d) => (
            <li key={d.id}>
              <a
                href={`#${d.id}`}
                className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {d.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-10 space-y-8">
        {DECISIONS.map((d) => (
          <Entry key={d.id} d={d} />
        ))}
      </div>
    </div>
  );
}

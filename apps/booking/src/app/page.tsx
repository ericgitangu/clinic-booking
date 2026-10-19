import type { Metadata } from "next";
import { CalendarCheck, GitBranch, Play } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { LotusMark } from "@clinic/ui/components/brand/lotus-mark";
import { Ripples } from "@clinic/ui/components/brand/ripples";
import { Button } from "@clinic/ui/components/ui/button";
import { Separator } from "@clinic/ui/components/ui/separator";
import { CopyBlock } from "@/components/landing/copy-block";
import { EvidenceCard } from "@/components/landing/evidence-card";
import { StatusLine, StatusPending } from "@/components/landing/status-line";
import {
  ADR,
  BONUS,
  GITHUB,
  README,
  REQUIRED,
  STEPS,
  TILES,
} from "@/lib/evidence";
import { pageMetadata } from "@/lib/metadata";
import { SITE } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: SITE.name,
  description: SITE.description,
  path: "/",
});

// The page reads the API's readiness on every request (that call is cached for 30 seconds).
export const dynamic = "force-dynamic";

// Links inside a sentence get padding that makes the touch target 44px tall without moving the text.
const LINK =
  "-my-3 inline-block py-3 underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring";

export default function Home() {
  return (
    <>
      <section className="grid items-center gap-10 py-12 md:grid-cols-[1.2fr_0.8fr] md:py-16">
        <div className="max-w-2xl">
          <h1 className="font-heading text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            {SITE.name}
          </h1>
          <p className="mt-5 max-w-[60ch] text-lg leading-8 text-muted-foreground">
            A clinic appointment API with a booking app, built for the Savannah
            Informatics backend assessment.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-12 px-5 text-base">
              <Link href="/book">
                <CalendarCheck aria-hidden />
                Book a visit
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 px-5 text-base"
            >
              <a href="/docs">
                <Play aria-hidden />
                API docs (Swagger)
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 px-5 text-base"
            >
              <a href={GITHUB}>
                <GitBranch aria-hidden />
                Source on GitHub
              </a>
            </Button>
          </div>
        </div>
        <div className="flex justify-center md:justify-end">
          <div className="relative flex size-56 items-center justify-center rounded-full bg-accent sm:size-72 dark:bg-[#eef5fb]">
            <Ripples />
            <LotusMark
              size={240}
              className="lotus-settle size-40 sm:size-52 dark:bg-transparent dark:p-0"
            />
          </div>
        </div>
      </section>

      <Separator />

      <section aria-labelledby="brief" className="py-12">
        <h2
          id="brief"
          className="font-heading text-2xl font-semibold tracking-tight"
        >
          What the brief asked for, and where to try it
        </h2>
        <p className="mt-3 max-w-[65ch] text-base leading-7 text-muted-foreground">
          Each card names an operation, the errors it returns, a link that opens
          that operation in Swagger, and the screen that uses it.
        </p>
        <h3 className="mt-8 font-heading text-lg font-semibold">Required</h3>
        <ul className="mt-4 grid gap-4 md:grid-cols-2">
          {REQUIRED.map((e) => (
            <EvidenceCard key={e.operationId} e={e} required />
          ))}
        </ul>
        <h3 className="mt-10 font-heading text-lg font-semibold">Bonus</h3>
        <ul className="mt-4 grid gap-4 md:grid-cols-2">
          {BONUS.map((e) => (
            <EvidenceCard
              key={e.method + e.path + e.summary}
              e={e}
              required={false}
            />
          ))}
        </ul>
      </section>

      <Separator />

      <section aria-labelledby="verify" className="py-12">
        <h2
          id="verify"
          className="font-heading text-2xl font-semibold tracking-tight"
        >
          Verify the claims in 10 minutes
        </h2>
        <p className="mt-3 max-w-[65ch] text-base leading-7 text-muted-foreground">
          Three commands against the live API. They need curl and jq, and they
          create test data: a patient or two and one appointment.
        </p>
        <ol className="mt-8 space-y-8">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid gap-3 md:grid-cols-[2.5rem_1fr]">
              <span
                aria-hidden
                className="hidden size-10 items-center justify-center rounded-full bg-primary font-heading text-lg font-semibold text-primary-foreground md:flex"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <h3 className="font-heading text-lg font-semibold">
                  <span className="md:hidden">{i + 1}. </span>
                  {s.title}
                </h3>
                <p className="mt-1 max-w-[65ch] text-base leading-7 text-muted-foreground">
                  {s.body}
                </p>
                <div className="mt-3">
                  <CopyBlock code={s.code} label={s.title} />
                </div>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-8 max-w-[65ch] text-base leading-7 text-muted-foreground">
          To run them against a local stack, set{" "}
          <code>API=http://localhost:8080</code> in the first block.
        </p>
        <p className="mt-3 text-base">
          The same checks, with what I saw when I ran them, are in{" "}
          <a
            className={LINK}
            href={`${README}#2-verify-the-claims-in-10-minutes`}
          >
            README section 2
          </a>
          .
        </p>
      </section>

      <Separator />

      <section aria-labelledby="built" className="py-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2
            id="built"
            className="font-heading text-2xl font-semibold tracking-tight"
          >
            How it&rsquo;s built
          </h2>
          <Suspense fallback={null}>
            <Suspense fallback={<StatusPending />}>
              <StatusLine />
            </Suspense>
          </Suspense>
        </div>
        <dl className="mt-6 grid gap-x-10 gap-y-8 md:grid-cols-2">
          {TILES.map((t) => (
            <div key={t.title} className="border-t border-border pt-4">
              <dt className="font-heading text-lg font-semibold">{t.title}</dt>
              <dd className="mt-2 max-w-[60ch] text-base leading-7 text-muted-foreground">
                {t.body}
              </dd>
              <dd className="mt-3 flex flex-wrap gap-x-5 text-base">
                <a className={LINK} href={ADR(t.adr)}>
                  {t.label}
                </a>
                {"extra" in t ? (
                  <a className={LINK} href={t.extra.href}>
                    {t.extra.label}
                  </a>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Separator />

      <section aria-labelledby="ai" className="py-12">
        <h2
          id="ai"
          className="font-heading text-2xl font-semibold tracking-tight"
        >
          Section 4: AI usage
        </h2>
        <p className="mt-3 max-w-[65ch] text-base leading-7">
          I built this with an AI coding assistant, and how I used it is written
          up in{" "}
          <a className={LINK} href={`${README}#11-ai-reflection`}>
            README section 11
          </a>
          .
        </p>
        <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
          Doctor portraits are AI-generated fictional people.{" "}
          <a className={LINK} href={`${README}#doctor-portraits-ai-generated`}>
            How they were made
          </a>
          .
        </p>
      </section>
    </>
  );
}

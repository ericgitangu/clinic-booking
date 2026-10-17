import Link from "next/link";
import { SITE } from "@/lib/site";
import { LotusMark } from "@clinic/ui/components/brand/lotus-mark";
import { Button } from "@clinic/ui/components/ui/button";
import { Separator } from "@clinic/ui/components/ui/separator";

// Static: no data, no client JavaScript beyond the theme control in the header.
export const dynamic = "force-static";

const GUARANTEES = [
  {
    title: "One slot, one booking",
    body: "Two people can never hold the same time. The database enforces it, and a test fires 25 requests at one slot to prove it.",
  },
  {
    title: "Times that cannot be misread",
    body: "Every time carries its Nairobi offset (+03:00). A time without one is refused instead of guessed.",
  },
  {
    title: "Errors you can act on",
    body: "A failure says what went wrong and carries a code to handle, in a standard problem response.",
  },
] as const;

const DEVELOPER_LINKS = [
  {
    href: "/docs",
    label: "Swagger UI",
    note: "Try every endpoint in the browser.",
  },
  {
    href: "/redoc",
    label: "ReDoc",
    note: "The same API as a readable reference.",
  },
  {
    href: "/openapi.json",
    label: "OpenAPI contract",
    note: "The machine-readable source of truth.",
  },
  {
    href: "/api/health",
    label: "Health",
    note: "Is the service up right now.",
  },
] as const;

export default function Home() {
  return (
    <>
      <section className="grid items-center gap-10 py-14 md:grid-cols-[1.15fr_0.85fr] md:py-20">
        <div className="max-w-xl">
          <h1 className="font-heading text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            {SITE.name}
          </h1>
          <p className="mt-5 max-w-[60ch] text-lg leading-8 text-muted-foreground">
            Book your visit. See a doctor&rsquo;s free slots, pick a time, and
            cancel or reschedule when plans change. The API behind the booking
            pages is live and open to try too.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-11 px-5 text-base">
              <Link href="/book">Book a visit</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-11 px-5 text-base"
            >
              <a href="/docs">Open the API docs</a>
            </Button>
          </div>
        </div>
        <div className="flex justify-center md:justify-end">
          <div className="flex size-64 items-center justify-center rounded-full bg-accent sm:size-80 dark:bg-[#eef5fb]">
            <LotusMark
              size={240}
              priority
              className="lotus-settle size-44 sm:size-56 dark:bg-transparent dark:p-0"
            />
          </div>
        </div>
      </section>

      <Separator />

      <section
        aria-labelledby="behaviour"
        className="grid gap-8 py-14 md:grid-cols-[0.7fr_1.3fr]"
      >
        <h2
          id="behaviour"
          className="font-heading text-2xl font-semibold tracking-tight"
        >
          How it behaves
        </h2>
        <dl className="divide-y divide-border">
          {GUARANTEES.map((item) => (
            <div key={item.title} className="py-5 first:pt-0 last:pb-0">
              <dt className="font-heading text-lg font-medium">{item.title}</dt>
              <dd className="mt-2 max-w-[62ch] leading-7 text-muted-foreground">
                {item.body}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Separator />

      <section
        aria-labelledby="developers"
        className="grid gap-8 py-14 md:grid-cols-[0.7fr_1.3fr]"
      >
        <h2
          id="developers"
          className="font-heading text-2xl font-semibold tracking-tight"
        >
          For developers
        </h2>
        <ul className="divide-y divide-border">
          {DEVELOPER_LINKS.map((link) => (
            <li key={link.href} className="py-4 first:pt-0 last:pb-0">
              <a
                href={link.href}
                className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {link.label}
              </a>
              <p className="mt-1 text-muted-foreground">{link.note}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

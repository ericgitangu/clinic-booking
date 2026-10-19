import {
  Briefcase,
  CalendarCheck,
  Code,
  Database,
  ExternalLink,
  FileText,
  FileUser,
  GitBranch,
  Globe,
  ListChecks,
  PenLine,
  Scale,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";
import { Separator } from "@clinic/ui/components/ui/separator";
import type { FooterColumn, FooterLink } from "@clinic/ui/lib/footer";

// The sentence reCAPTCHA needs on a page that hides its badge. Google's FAQ now asks only for
// "This site is protected by reCAPTCHA."; this is the longer wording with the two policy links that
// the engineer chose to keep, which is still accurate.
export const RECAPTCHA_ATTRIBUTION =
  "This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.";

const ICONS: Record<FooterLink["icon"], LucideIcon> = {
  calendar: CalendarCheck,
  shield: ShieldCheck,
  docs: FileText,
  code: Code,
  git: GitBranch,
  workflow: Workflow,
  briefcase: Briefcase,
  pen: PenLine,
  "file-user": FileUser,
  globe: Globe,
  scale: Scale,
  database: Database,
  list: ListChecks,
};

// Policy links sit inside a sentence: padding makes the touch target 44px tall without moving the text.
const INLINE_LINK =
  "-my-3 inline-block rounded-sm py-3 underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

function FooterAnchor({ link }: { link: FooterLink }) {
  const Icon = ICONS[link.icon];
  const content = (
    <>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>{link.label}</span>
      {link.external ? (
        <>
          <ExternalLink aria-hidden className="size-3 shrink-0 opacity-70" />
          <span className="sr-only">(opens in a new tab)</span>
        </>
      ) : null}
    </>
  );
  // A long label wraps instead of pushing the page wider; a short one is still one 44 px line.
  const className =
    "h-auto min-h-11 justify-start gap-2 whitespace-normal px-0 py-2 text-left text-base sm:text-sm";
  return (
    <Button asChild variant="link" className={className}>
      {link.external ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : link.href.startsWith("/") && !link.href.includes(".") ? (
        <Link href={link.href}>{content}</Link>
      ) : (
        // Route handlers (docs, OpenAPI) are not pages: a plain anchor avoids client routing.
        <a href={link.href}>{content}</a>
      )}
    </Button>
  );
}

export function SiteFooter({
  columns,
  notice,
}: {
  columns: readonly FooterColumn[];
  notice: string;
}) {
  return (
    <footer className="mt-auto">
      <Separator />
      <div className="pad-safe-x mx-auto w-full max-w-5xl pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 text-muted-foreground">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2 className="font-heading text-base font-semibold text-foreground">
                {col.title}
              </h2>
              <ul className="mt-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <FooterAnchor link={l} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <Separator className="my-6" />
        <div className="space-y-2 text-base sm:text-sm">
          <p>{notice}</p>
          <p>
            This site is protected by reCAPTCHA and the Google{" "}
            <a
              href="https://policies.google.com/privacy"
              className={INLINE_LINK}
              target="_blank"
              rel="noopener noreferrer"
            >
              Privacy Policy
            </a>{" "}
            and{" "}
            <a
              href="https://policies.google.com/terms"
              className={INLINE_LINK}
              target="_blank"
              rel="noopener noreferrer"
            >
              Terms of Service
            </a>{" "}
            apply.
          </p>
        </div>
      </div>
    </footer>
  );
}

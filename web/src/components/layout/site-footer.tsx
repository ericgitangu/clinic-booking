import Link from "next/link";
import { Separator } from "@/components/ui/separator";

// The sentence reCAPTCHA needs on a page that hides its badge. Google's FAQ now asks only for
// "This site is protected by reCAPTCHA."; this is the longer wording with the two policy links that
// the engineer chose to keep, which is still accurate.
export const RECAPTCHA_ATTRIBUTION =
  "This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.";

const LEGAL_LINK =
  "inline-flex min-h-11 items-center rounded-md underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
// Policy links sit inside a sentence: padding makes the touch target 44px tall without moving the text.
const INLINE_LINK =
  "-my-3 inline-block rounded-sm py-3 underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function SiteFooter() {
  return (
    <footer className="mt-auto">
      <Separator />
      <div className="pad-safe-x mx-auto flex w-full max-w-5xl flex-col gap-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 text-base text-muted-foreground sm:text-sm">
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6">
          <Link href="/privacy" className={LEGAL_LINK}>
            Privacy
          </Link>
          <Link href="/terms" className={LEGAL_LINK}>
            Terms
          </Link>
        </nav>
        <p>
          Idyllic clinic, Nairobi. Times are shown in East Africa Time (UTC+3).
        </p>
        <p>
          This site is protected by reCAPTCHA and the Google{" "}
          <a
            href="https://policies.google.com/privacy"
            className={INLINE_LINK}
            rel="noopener noreferrer"
          >
            Privacy Policy
          </a>{" "}
          and{" "}
          <a
            href="https://policies.google.com/terms"
            className={INLINE_LINK}
            rel="noopener noreferrer"
          >
            Terms of Service
          </a>{" "}
          apply.
        </p>
      </div>
    </footer>
  );
}

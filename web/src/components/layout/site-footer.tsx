import { Separator } from "@/components/ui/separator";

// Google's FAQ lets the reCAPTCHA badge be hidden if the site says it uses reCAPTCHA.
export const RECAPTCHA_ATTRIBUTION = "This site is protected by reCAPTCHA.";

export function SiteFooter() {
  return (
    <footer className="mt-auto">
      <Separator />
      <div className="pad-safe-x mx-auto flex w-full max-w-5xl flex-col gap-3 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 text-base text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:text-sm">
        <p>
          Idyllic clinic, Nairobi. Times are shown in East Africa Time (UTC+3).
        </p>
        <p>{RECAPTCHA_ATTRIBUTION}</p>
      </div>
    </footer>
  );
}

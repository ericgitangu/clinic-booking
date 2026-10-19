import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";
import { FORBIDDEN_MESSAGE } from "@/lib/auth-failure";

// Shown when the API says the signed-in account may not see or change something (HTTP 403).
export function NoAccess({ back }: { back: { href: string; label: string } }) {
  return (
    <section className="mx-auto max-w-md py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        {FORBIDDEN_MESSAGE}
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        This account is not allowed to open it.
      </p>
      <Button asChild size="lg" className="mt-8 h-12 px-6 text-base">
        <Link href={back.href}>{back.label}</Link>
      </Button>
    </section>
  );
}

import { Button } from "@clinic/ui/components/ui/button";
import { SITE } from "@/lib/site";

// The sign-in gate. Sign-in is not wired yet, so the button says so instead of pretending.
export default function SignInGate() {
  return (
    <section className="mx-auto max-w-md py-16">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        {SITE.name}
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        Staff sign in with their Google account. Sign-in is not available yet.
      </p>
      <Button size="lg" className="mt-8 h-11 w-full text-base" disabled>
        Sign in with Google
      </Button>
    </section>
  );
}

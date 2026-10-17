import { forbidden, redirect } from "next/navigation";
import { SignInButton } from "@/components/sign-in-button";
import { SITE } from "@/lib/site";
import { getStaff } from "@/lib/session";

export const dynamic = "force-dynamic";

// The sign-in gate. Someone already in goes to the dashboard; someone signed in without access
// sees the 403 page rather than a sign-in button that would only loop.
export default async function SignInGate() {
  const staff = await getStaff();
  if (staff) {
    if (staff.role) redirect("/dashboard");
    forbidden();
  }
  return (
    <section className="mx-auto max-w-md py-16">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        {SITE.name}
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        For clinic staff. Sign in with the Google account the owner added.
      </p>
      <SignInButton />
    </section>
  );
}

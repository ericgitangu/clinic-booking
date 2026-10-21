import type { Metadata } from "next";
import Link from "next/link";
import { AcceptPass } from "@/components/accept-pass";
import { SignInButton } from "@/components/sign-in-button";
import { getStaff } from "@/lib/session";
import { SITE } from "@/lib/site";

// The token is in the address, so the page must not send it anywhere: no Referer, no indexing.
export const metadata: Metadata = {
  title: "Reviewer pass",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

export default async function PassPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const staff = TOKEN.test(token) ? await getStaff() : null;
  return (
    <section className="mx-auto max-w-md py-16">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Open the {SITE.name} dashboard
      </h1>
      {!TOKEN.test(token) ? (
        <p className="mt-4 text-lg leading-8 text-muted-foreground">
          That reviewer pass link is not valid. Ask the person who sent it for a
          new one.
        </p>
      ) : staff?.role === "owner" ? (
        <p className="mt-4 text-lg leading-8 text-muted-foreground">
          You are the owner, so this link is not for you: it is for the people
          you send it to. Open the{" "}
          <Link href="/access" className="underline underline-offset-4">
            Access page
          </Link>{" "}
          to see who has used it.
        </p>
      ) : staff ? (
        <>
          <p className="mt-4 text-lg leading-8 text-muted-foreground">
            You are signed in as{" "}
            <span className="font-medium text-foreground">{staff.email}</span>.
            Accepting gives this account access to the dashboard.
          </p>
          <AcceptPass token={token} />
          <p className="mt-6 text-sm text-muted-foreground">
            Wrong account? Sign out from the menu at the top and open the link
            again.
          </p>
        </>
      ) : (
        <>
          <p className="mt-4 text-lg leading-8 text-muted-foreground">
            Sign in with any Google account to accept.
          </p>
          <SignInButton callbackURL={`/pass/${token}`} />
          <p className="mt-6 text-sm text-muted-foreground">
            <Link href="/" className="underline underline-offset-4">
              Back to the sign-in page
            </Link>
          </p>
        </>
      )}
    </section>
  );
}

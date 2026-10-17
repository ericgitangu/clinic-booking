import { SignInButton } from "@/components/account/sign-in-button";

// Shown where an account is needed. The button returns the person to the same page.
export function SignInPrompt({
  title,
  body,
  returnTo,
}: {
  title: string;
  body: string;
  returnTo: string;
}) {
  return (
    <section className="mx-auto max-w-md py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">{body}</p>
      <SignInButton
        returnTo={returnTo}
        className="mt-8 h-12 w-full text-base"
      />
    </section>
  );
}

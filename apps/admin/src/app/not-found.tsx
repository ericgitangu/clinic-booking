import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <section className="mx-auto max-w-md py-16">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        We could not find that page
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        The address may be mistyped, or the appointment may no longer exist.
      </p>
      <Button asChild className="mt-6 min-h-11">
        <Link href="/dashboard">Back to the dashboard</Link>
      </Button>
    </section>
  );
}

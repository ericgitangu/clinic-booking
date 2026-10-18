import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <section className="max-w-xl py-16">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        We could not find that page
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        The address may be mistyped, or the doctor or appointment may no longer
        exist. Start again from the list of doctors.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild size="lg" className="h-12 px-6 text-base">
          <Link href="/book">Book a visit</Link>
        </Button>
        <Button
          asChild
          size="lg"
          variant="outline"
          className="h-12 px-6 text-base"
        >
          <Link href="/">Home</Link>
        </Button>
      </div>
    </section>
  );
}

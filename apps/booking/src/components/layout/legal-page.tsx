import type { ReactNode } from "react";

// Shared frame for the short legal pages: one h1, readable line length, dated.
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <article className="max-w-[65ch] py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h1>
      <p className="mt-2 text-muted-foreground">Last updated {updated}.</p>
      <div className="mt-8 space-y-5 text-base leading-7 [&_h2]:mt-10 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:font-heading [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_li_a]:-my-3 [&_li_a]:inline-block [&_li_a]:py-3">
        {children}
      </div>
    </article>
  );
}

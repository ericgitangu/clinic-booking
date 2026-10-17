import type { Metadata } from "next";

export const metadata: Metadata = { title: "Dashboard" };

// The dashboard frame. It holds no data and no appointments yet.
export default function Dashboard() {
  return (
    <section className="py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Dashboard
      </h1>
      <p className="mt-4 max-w-[60ch] text-lg leading-8 text-muted-foreground">
        Nothing to show yet. The day&rsquo;s appointments will appear here once
        the dashboard is connected.
      </p>
    </section>
  );
}

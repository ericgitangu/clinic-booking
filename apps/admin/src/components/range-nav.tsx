"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { vibrate } from "@clinic/ui/lib/haptics";
import { cn } from "@clinic/ui/lib/utils";
import { RANGES } from "@/lib/filters";

// The range lives in the address, so a refresh or a shared link shows the same days. These are
// links, not tabs: each one loads a different page of data, and there is no panel to switch.
export function RangeNav({ days }: { days: number }) {
  const path = usePathname();
  const params = useSearchParams();

  function hrefFor(value: number) {
    const next = new URLSearchParams(params.toString());
    next.set("days", String(value));
    next.delete("cursor");
    return `${path}?${next.toString()}`;
  }

  return (
    <nav
      aria-label="Range"
      className="inline-flex rounded-lg bg-muted p-1"
      data-testid="range-nav"
    >
      {RANGES.map((d) => (
        <Link
          key={d}
          href={hrefFor(d)}
          aria-current={d === days ? "page" : undefined}
          onClick={() => vibrate("info")}
          className={cn(
            "inline-flex min-h-9 items-center rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            d === days
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {d} days
        </Link>
      ))}
    </nav>
  );
}

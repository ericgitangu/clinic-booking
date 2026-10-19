import type { ReactNode } from "react";
import Link from "next/link";
import { FigureSheet } from "@/components/figure-sheet";
import { DrillSheet } from "@/components/drill-sheet";
import type { DrillConfig } from "@/lib/drill";
import { CountUp } from "@/components/count-up";
import { ArrowDownIcon, ArrowUpIcon, EqualIcon } from "lucide-react";
import { cn } from "@clinic/ui/lib/utils";
import type { Delta } from "@/lib/kpi-delta";

export interface Kpi {
  label: string;
  value: string;
  /** What the number counts, so nobody has to guess whether "7" means this week or all time. */
  note: string;
  /** Where the card leads, when the number is a list one click away. */
  href?: string;
  /** The appointments behind the number, opened in a sheet. Its count is the number's count. */
  drill?: DrillConfig;
  /** For a figure the API gives only as a number: its sheet of numbers, and the gap named. */
  figure?: { title: string; description: string; gap: string; body: ReactNode };
  /** Change against the period before; omitted for numbers that are a snapshot of now. */
  delta?: Delta | null;
}

const TONE = {
  good: "text-chart-2",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
} as const;

function DeltaLine({ id, delta }: { id: string; delta: Delta }) {
  const Icon =
    delta.direction === "up"
      ? ArrowUpIcon
      : delta.direction === "down"
        ? ArrowDownIcon
        : EqualIcon;
  return (
    <p
      className="mt-2 flex items-center gap-1.5 text-sm font-medium"
      data-testid={`${id}-delta`}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", TONE[delta.tone])} />
      <span>{delta.text}</span>
    </p>
  );
}

// The numbers the front desk looks at first. Cards that measure a period carry the change against
// the period before; the one snapshot of now (upcoming) says so instead of inventing a comparison.
export function KpiStrip({
  items,
  comparedWith,
  canAct = false,
}: {
  items: readonly Kpi[];
  /** Owner and admin: the rows in a card's sheet open sheets that carry the actions. */
  canAct?: boolean;
  /** e.g. "the 14 days before"; names what every change is measured against. */
  comparedWith: string;
}) {
  return (
    <section aria-labelledby="kpis" className="space-y-2">
      <h2 id="kpis" className="sr-only">
        Key numbers
      </h2>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((k) => {
          const id = k.label.toLowerCase().replace(/[^a-z]+/g, "-");
          const body = (
            <>
              <p className="text-sm text-muted-foreground">{k.label}</p>
              <p className="mt-1 font-heading text-3xl font-semibold tabular-nums">
                <CountUp value={k.value} testId={`kpi-${id}`} />
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{k.note}</p>
              {k.delta ? <DeltaLine id={`kpi-${id}`} delta={k.delta} /> : null}
              {k.drill ? (
                <span className="sr-only">
                  Opens the visits behind this number.
                </span>
              ) : null}
            </>
          );
          const base =
            "block h-full rounded-xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur-sm";
          return (
            <li key={k.label}>
              {k.drill ? (
                <DrillSheet
                  config={{ ...k.drill, canAct }}
                  className={cn(
                    base,
                    "w-full text-left motion-safe:transition-[transform,box-shadow,background-color] hover:bg-card hover:shadow-md motion-safe:active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  {body}
                </DrillSheet>
              ) : k.figure ? (
                <FigureSheet
                  title={k.figure.title}
                  description={k.figure.description}
                  gap={k.figure.gap}
                  className={cn(
                    base,
                    "w-full text-left motion-safe:transition-[transform,box-shadow,background-color] hover:bg-card hover:shadow-md motion-safe:active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  )}
                  trigger={body}
                >
                  {k.figure.body}
                </FigureSheet>
              ) : k.href ? (
                <Link
                  href={k.href}
                  className={cn(
                    base,
                    "motion-safe:transition-[transform,box-shadow,background-color] hover:bg-card hover:shadow-md motion-safe:active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  {body}
                </Link>
              ) : (
                <div className={base}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-muted-foreground">
        Changes compare with {comparedWith}.
      </p>
    </section>
  );
}

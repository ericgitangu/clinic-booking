import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@clinic/ui/components/ui/card";
import { ChangesSheet } from "@/components/changes-sheet";
import { REASON_GAP } from "@/lib/figure-gaps";
import type { ReasonBreakdown } from "@clinic/api/generated";

const LABEL: Record<ReasonBreakdown["items"][number]["category"], string> = {
  transport: "Transport",
  illness: "Illness",
  travel: "Travel",
  work: "Work",
  weather: "Weather",
  felt_better: "Felt better",
  insurance: "Insurance",
  other: "Other",
};

// Why visits were cancelled, grouped by the API from the reason text. Every row prints its count
// and share, so the bar is a picture of numbers that are already on the page.
export function ReasonsChart({
  data,
  days,
  range,
  canAct = false,
}: {
  data: ReasonBreakdown;
  days: number;
  /** Clinic-local [from, to) of the range the figures cover. */
  range: { from: string; to: string };
  canAct?: boolean;
}) {
  const rows = [...data.items]
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  return (
    <Card className="bg-card/80 shadow-sm backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="font-heading text-lg">
          Why visits were cancelled
        </CardTitle>
        <CardDescription>
          {data.total} cancelled in the last {days} days (by the day they were
          cancelled), grouped by the reason given.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p
            className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground"
            data-testid="reasons-empty"
          >
            No cancellations in these days, so there is nothing to group.
          </p>
        ) : (
          <ul className="space-y-3" data-testid="reasons-list">
            {rows.map((r) => (
              <li key={r.category}>
                <ChangesSheet
                  className="block w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  title={`${LABEL[r.category]}: ${r.count} of ${data.total}`}
                  description={`Cancellations grouped under this reason, last ${days} days.`}
                  gap={REASON_GAP}
                  range={range}
                  canAct={canAct}
                  options={[
                    {
                      kind: "cancelled",
                      label: LABEL[r.category],
                      expected: r.count,
                      reason: r.category,
                    },
                  ]}
                  trigger={
                    <span data-testid="reason-row">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{LABEL[r.category]}</span>
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {r.count} ({Math.round(r.share * 100)}%)
                        </span>
                      </div>
                      <div
                        aria-hidden="true"
                        className="mt-1 h-2.5 overflow-hidden rounded-full bg-muted ring-1 ring-border"
                      >
                        <div
                          className="bar-grow h-full rounded-full bg-chart-1"
                          style={{ width: `${Math.max(2, r.share * 100)}%` }}
                        />
                      </div>
                    </span>
                  }
                  figure={
                    <p className="tabular-nums" data-testid="figure-reason">
                      {r.count} of {data.total} cancelled (
                      {Math.round(r.share * 100)}%) were put under{" "}
                      {LABEL[r.category].toLowerCase()}.
                    </p>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@clinic/ui/components/ui/card";
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
}: {
  data: ReasonBreakdown;
  days: number;
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
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@clinic/ui/components/ui/card";
import { DrillSheet } from "@/components/drill-sheet";
import { DoctorSelect } from "@/components/doctor-select";
import type { Heatmap } from "@clinic/api/generated";

const DAYS = [
  [1, "Mon", "Monday"],
  [2, "Tue", "Tuesday"],
  [3, "Wed", "Wednesday"],
  [4, "Thu", "Thursday"],
  [5, "Fri", "Friday"],
  [6, "Sat", "Saturday"],
  [7, "Sun", "Sunday"],
] as const;

// Booked visits by weekday and start hour. Every cell prints its count, and the shade only
// repeats it, so the picture needs no colour vision. The hours shown run from the first to the last
// hour that has a booking, never fewer than 7 to 17 (a normal clinic day).
export function PeakHours({
  data,
  doctors,
  selected,
  days,
  range,
  canAct = false,
}: {
  data: Heatmap;
  doctors: readonly { id: string; name: string }[];
  selected: string | null;
  days: number;
  range: { from: string; to: string };
  canAct?: boolean;
}) {
  const count = new Map(
    data.cells.map((c) => [`${c.weekday}-${c.hour}`, c.count]),
  );
  const hoursWithData = data.cells
    .filter((c) => c.count > 0)
    .map((c) => c.hour);
  const first = Math.min(7, ...hoursWithData);
  const last = Math.max(17, ...hoursWithData);
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const empty = hoursWithData.length === 0;
  return (
    <Card className="bg-card/80 shadow-sm backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Peak hours</CardTitle>
        <CardDescription>
          Visits booked by weekday and start time, last {days} days.
        </CardDescription>
        <DoctorSelect doctors={doctors} selected={selected} />
      </CardHeader>
      <CardContent>
        {empty ? (
          <p
            className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground"
            data-testid="heatmap-empty"
          >
            No visits are booked in these days yet. Busy hours show here once
            there are some.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Peak hours table, scrolls sideways on a small screen"
            tabIndex={0}
            className="overflow-x-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table
              className="w-full border-separate border-spacing-0.5 text-center text-xs tabular-nums"
              data-testid="heatmap"
            >
              <caption className="sr-only">
                Booked visits by weekday and hour
              </caption>
              <thead>
                <tr>
                  <td />
                  {hours.map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-1 pb-1 font-medium text-muted-foreground"
                    >
                      {String(h).padStart(2, "0")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map(([n, short, long]) => (
                  <tr key={n}>
                    <th
                      scope="row"
                      className="pr-2 text-left font-medium text-muted-foreground"
                    >
                      <span aria-hidden="true">{short}</span>
                      <span className="sr-only">{long}</span>
                    </th>
                    {hours.map((h) => {
                      const c = count.get(`${n}-${h}`) ?? 0;
                      const share = data.max > 0 ? c / data.max : 0;
                      return (
                        <td
                          key={h}
                          className="h-8 min-w-8 rounded-sm text-foreground"
                          style={{
                            background:
                              c > 0
                                ? `color-mix(in oklab, var(--chart-2) ${Math.round(share * 38)}%, transparent)`
                                : "var(--muted)",
                          }}
                        >
                          {c === 0 ? (
                            <span className="text-muted-foreground">0</span>
                          ) : (
                            <DrillSheet
                              label={`${c} ${c === 1 ? "visit" : "visits"} on ${long}s at ${String(h).padStart(2, "0")}:00. Show them.`}
                              className="flex size-full min-h-8 min-w-8 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                              config={{
                                title: `${long}s at ${String(h).padStart(2, "0")}:00`,
                                description: `Booked visits starting at that time of the week, last ${days} days.`,
                                spec: {
                                  ...range,
                                  status: "booked",
                                  doctorId: selected ?? undefined,
                                },
                                slot: { weekday: n, hour: h },
                                canAct,
                              }}
                            >
                              {c}
                            </DrillSheet>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

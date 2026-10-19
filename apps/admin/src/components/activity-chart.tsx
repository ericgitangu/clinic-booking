"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@clinic/ui/components/ui/chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@clinic/ui/components/ui/card";

export interface ActivityRow {
  /** Short label for the axis, such as "20 Oct". */
  label: string;
  booked: number;
  rescheduled: number;
  cancelled: number;
}

const config = {
  booked: { label: "Booked", color: "var(--chart-1)" },
  rescheduled: { label: "Rescheduled", color: "var(--chart-3)" },
  cancelled: { label: "Cancelled", color: "var(--destructive)" },
} satisfies ChartConfig;

// Activity is when people booked, rescheduled or cancelled, not when the visit happens. Each line
// differs in dash as well as colour so the three stay apart without relying on hue.
export function ActivityChart({ rows }: { rows: ActivityRow[] }) {
  const sum = (k: "booked" | "rescheduled" | "cancelled") =>
    rows.reduce((n, r) => n + r[k], 0);
  const total = sum("booked") + sum("rescheduled") + sum("cancelled");
  const busiest = rows.reduce(
    (best, r) =>
      r.booked + r.rescheduled + r.cancelled >
      best.booked + best.rescheduled + best.cancelled
        ? r
        : best,
    rows[0]!,
  );
  return (
    <Card className="bg-card/80 shadow-sm backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Activity per day</CardTitle>
        <CardDescription>
          Bookings, reschedules and cancellations by the day they were made.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-10 text-center text-muted-foreground">
            Nothing was booked, moved or cancelled in these days. Try a longer
            range, or check back once patients start booking.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm" data-testid="activity-summary">
              {sum("booked")} booked, {sum("rescheduled")} rescheduled and{" "}
              {sum("cancelled")} cancelled over {rows.length} days. Busiest day:{" "}
              {busiest.label},{" "}
              {busiest.booked + busiest.rescheduled + busiest.cancelled}{" "}
              actions.
            </p>
            <ChartContainer
              config={config}
              className="aspect-[4/3] w-full sm:aspect-[16/7]"
              role="img"
              aria-label={`Line chart of bookings, reschedules and cancellations per day. ${total} actions in total; the same numbers are in the table below the chart.`}
            >
              <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                />
                <YAxis
                  // Counts start at zero and never dip below it; a quiet range still gets a
                  // readable scale instead of one stretched to a single action.
                  domain={[0, (max: number) => Math.max(4, max)]}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  dataKey="booked"
                  type="linear"
                  stroke="var(--color-booked)"
                  strokeWidth={2.5}
                  dot={{ r: 2.5 }}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="rescheduled"
                  type="linear"
                  stroke="var(--color-rescheduled)"
                  strokeWidth={2.5}
                  strokeDasharray="7 4"
                  dot={{ r: 2.5 }}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="cancelled"
                  type="linear"
                  stroke="var(--color-cancelled)"
                  strokeWidth={2.5}
                  strokeDasharray="2 4"
                  dot={{ r: 2.5 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
            <details className="mt-4 rounded-lg border border-border">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                Show the numbers as a table
              </summary>
              <div className="px-3 pb-3">
                <table className="w-full text-sm tabular-nums">
                  <caption className="sr-only">Activity per day</caption>
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th scope="col" className="py-2 pr-2 font-medium">
                        Day
                      </th>
                      <th scope="col" className="py-2 pr-2 font-medium">
                        Booked
                      </th>
                      <th scope="col" className="py-2 pr-2 font-medium">
                        Rescheduled
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Cancelled
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} className="border-t border-border">
                        <th
                          scope="row"
                          className="py-1.5 pr-2 text-left font-normal"
                        >
                          {r.label}
                        </th>
                        <td className="pr-2">{r.booked}</td>
                        <td className="pr-2">{r.rescheduled}</td>
                        <td>{r.cancelled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

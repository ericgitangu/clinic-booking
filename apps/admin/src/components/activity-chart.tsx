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
  const total = rows.reduce(
    (n, r) => n + r.booked + r.rescheduled + r.cancelled,
    0,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-heading text-lg">Activity per day</CardTitle>
        <CardDescription>
          Bookings, reschedules and cancellations by the day they were made.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-10 text-center text-muted-foreground">
            Nothing was booked, moved or cancelled in this range.
          </p>
        ) : (
          <>
            <ChartContainer
              config={config}
              className="aspect-[4/3] w-full sm:aspect-[16/7]"
              role="img"
              aria-label={`Line chart of bookings, reschedules and cancellations per day. ${total} actions in total; the same numbers are in the table below.`}
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
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  dataKey="booked"
                  type="monotone"
                  stroke="var(--color-booked)"
                  strokeWidth={2.5}
                  dot={false}
                />
                <Line
                  dataKey="rescheduled"
                  type="monotone"
                  stroke="var(--color-rescheduled)"
                  strokeWidth={2.5}
                  strokeDasharray="7 4"
                  dot={false}
                />
                <Line
                  dataKey="cancelled"
                  type="monotone"
                  stroke="var(--color-cancelled)"
                  strokeWidth={2.5}
                  strokeDasharray="2 4"
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
            <table className="sr-only">
              <caption>Activity per day</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Booked</th>
                  <th scope="col">Rescheduled</th>
                  <th scope="col">Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td>{r.booked}</td>
                    <td>{r.rescheduled}</td>
                    <td>{r.cancelled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

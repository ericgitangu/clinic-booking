import { CountUp } from "@/components/count-up";
import { DrillSheet } from "@/components/drill-sheet";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@clinic/ui/components/ui/card";
import type { Metrics } from "@clinic/api/generated";

function percent(u: number | null): string {
  return u === null ? "No hours" : `${Math.round(u * 100)}%`;
}

// Booked visits against the slots the doctor works in the range. A doctor with no working hours
// has no utilisation to show, which is different from 0%. The bar is a picture of the figures
// printed beside it, so the number is never only a length.
export function DoctorUtilisation({
  doctors,
  days,
  range,
  canAct = false,
}: {
  doctors: Metrics["per_doctor"];
  days: number;
  range: { from: string; to: string };
  canAct?: boolean;
}) {
  return (
    <Card className="bg-card/80 shadow-sm backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="font-heading text-lg">
          Doctor utilisation
        </CardTitle>
        <CardDescription>
          Booked visits out of working slots, last {days} days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {doctors.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
            No doctors are set up yet. Add one and their workload shows here.
          </p>
        ) : (
          <ul className="space-y-5" data-testid="utilisation-list">
            {doctors.map((d) => {
              const pct = Math.round((d.utilization ?? 0) * 100);
              return (
                <li key={d.doctor_id} className="flex gap-3">
                  <span aria-hidden="true" className="contents">
                    <DoctorAvatar
                      doctorId={d.doctor_id}
                      name={d.name}
                      size={40}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-medium">{d.name}</span>
                      <span className="font-heading text-lg font-semibold tabular-nums">
                        <CountUp value={percent(d.utilization)} />
                      </span>
                    </div>
                    <div
                      role="meter"
                      aria-label={`${d.name} utilisation`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-valuetext={`${d.booked_visits} of ${d.capacity} slots, ${percent(d.utilization)}`}
                      className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-muted ring-1 ring-border"
                    >
                      <div
                        className="bar-grow h-full rounded-full bg-chart-2"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                      <DrillSheet
                        label={`${d.name}: ${d.booked_visits} booked visits. Show them.`}
                        className="rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        config={{
                          title: `${d.name}, booked visits`,
                          description: `Booked visits starting in the last ${days} days.`,
                          spec: {
                            ...range,
                            status: "booked",
                            doctorId: d.doctor_id,
                          },
                          canAct,
                        }}
                      >
                        <span data-testid="load-drill">
                          {d.booked_visits} booked
                        </span>
                      </DrillSheet>{" "}
                      of {d.capacity} slots
                      {d.cancelled_actions > 0
                        ? `, ${d.cancelled_actions} cancelled`
                        : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

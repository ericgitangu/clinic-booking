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
// has no utilisation to show, which is different from 0%.
export function DoctorUtilisation({
  doctors,
}: {
  doctors: Metrics["per_doctor"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-heading text-lg">
          Doctor utilisation
        </CardTitle>
        <CardDescription>
          Booked visits out of working slots in the range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {doctors.length === 0 ? (
          <p className="text-muted-foreground">No doctors are set up yet.</p>
        ) : (
          <ul className="space-y-4">
            {doctors.map((d) => (
              <li key={d.doctor_id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{d.name}</span>
                  <span className="tabular-nums text-sm text-muted-foreground">
                    {d.booked_visits} of {d.capacity} slots,{" "}
                    {percent(d.utilization)}
                  </span>
                </div>
                <div
                  role="meter"
                  aria-label={`${d.name} utilisation`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((d.utilization ?? 0) * 100)}
                  className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-chart-2"
                    style={{
                      width: `${Math.min(100, (d.utilization ?? 0) * 100)}%`,
                    }}
                  />
                </div>
                {d.cancelled_actions > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {d.cancelled_actions} cancelled in the range
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

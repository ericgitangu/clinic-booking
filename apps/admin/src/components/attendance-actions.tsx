"use client";

import { UserCheckIcon, UserXIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { markAttendance } from "@/lib/actions";

const WORD = { arrived: "arrived", no_show: "no-show" } as const;

// Arrived and No-show for one visit, from 15 minutes before it starts to 2 hours after. Every mark,
// the first one and a change of it alike, goes through the one confirmation dialog and asks for a
// reason. The page only renders this for owner and admin and only inside the window; the API checks
// both again.
export function AttendanceActions({
  appointmentId,
  mark,
}: {
  appointmentId: string;
  mark: "booked" | "arrived" | "no_show";
}) {
  if (mark === "booked") {
    return (
      <div className="flex flex-wrap gap-2">
        <Mark appointmentId={appointmentId} to="arrived" change={false} />
        <Mark appointmentId={appointmentId} to="no_show" change={false} />
      </div>
    );
  }
  return (
    <Mark
      appointmentId={appointmentId}
      to={mark === "arrived" ? "no_show" : "arrived"}
      change
    />
  );
}

function Mark({
  appointmentId,
  to,
  change,
}: {
  appointmentId: string;
  to: "arrived" | "no_show";
  change: boolean;
}) {
  const word = WORD[to];
  const Icon = to === "arrived" ? UserCheckIcon : UserXIcon;
  return (
    <ConfirmAction
      trigger={
        change ? (
          <Button size="sm" variant="ghost" className="min-h-11">
            Change to {word}
          </Button>
        ) : (
          <Button
            size="sm"
            variant={to === "arrived" ? "default" : "outline"}
            className="min-h-11"
          >
            <Icon aria-hidden /> Mark {word}
          </Button>
        )
      }
      title={change ? `Change to ${word}?` : `Mark as ${word}?`}
      description={
        change
          ? "This replaces the mark already made."
          : `Record that the patient ${to === "arrived" ? "has arrived" : "did not show"}. It counts in the day's figures.`
      }
      confirmLabel={change ? `Change to ${word}` : `Mark ${word}`}
      run={(reason) => markAttendance(appointmentId, to, reason)}
    />
  );
}

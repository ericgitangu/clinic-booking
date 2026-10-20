"use client";

import { LockIcon, LockOpenIcon, Undo2Icon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { unlockAppointment, vetoAppointment } from "@/lib/actions";

// Veto and lock, or unlock, for owner and admin, each through the one confirmation dialog. A veto
// undoes the patient's most recent change and locks the appointment so the patient cannot change it
// again until staff unlock it. The API checks the role again.
export function StaffControls({
  appointmentId,
  locked,
  canVeto,
  compact = false,
  onDone,
}: {
  appointmentId: string;
  locked: boolean;
  /** There is a patient change to undo (see lib/veto.ts); without one, Veto is not offered. */
  canVeto: boolean;
  /** Smaller and wrapping, for a row on the Today board. */
  compact?: boolean;
  /** Called after the change, for a sheet that has to read the appointment again. */
  onDone?: () => void;
}) {
  return (
    <div
      className={
        compact ? "flex flex-wrap gap-2" : "flex flex-col gap-3 sm:flex-row"
      }
    >
      {locked ? (
        <ConfirmAction
          trigger={
            <Button variant="outline" className="min-h-11">
              <LockOpenIcon aria-hidden /> Unlock
            </Button>
          }
          title="Unlock this appointment?"
          description="The patient will be able to change it again."
          confirmLabel="Unlock appointment"
          ownsAppointment={appointmentId}
          run={(reason) => unlockAppointment(appointmentId, reason)}
          onDone={onDone}
        />
      ) : canVeto ? (
        <ConfirmAction
          trigger={
            <Button variant="outline" className="min-h-11">
              <Undo2Icon aria-hidden /> Veto and lock
            </Button>
          }
          title="Undo the patient's last change?"
          description="Their most recent move is reversed and the appointment is locked, so they cannot change it again until you unlock it."
          confirmLabel="Veto and lock"
          ownsAppointment={appointmentId}
          run={(reason) => vetoAppointment(appointmentId, reason)}
          onDone={onDone}
        />
      ) : null}
    </div>
  );
}

export function LockedNote() {
  return (
    <p
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
      data-testid="locked-note"
    >
      <LockIcon className="size-4" aria-hidden /> Locked by staff. The patient
      cannot change this appointment.
    </p>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LockIcon, LockOpenIcon, Undo2Icon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@clinic/ui/components/ui/dialog";
import { Label } from "@clinic/ui/components/ui/label";
import { Textarea } from "@clinic/ui/components/ui/textarea";
import { notify } from "@clinic/ui/lib/notify";
import {
  unlockAppointment,
  vetoAppointment,
  type ActionResult,
} from "@/lib/actions";

// Veto and lock, or unlock, for owner and admin. A veto undoes the patient's most recent change and
// locks the appointment so the patient cannot change it again until staff unlock it. Both need a
// reason, which is kept in the audit trail. The API checks the role again.
export function StaffControls({
  appointmentId,
  locked,
  canVeto,
  compact = false,
}: {
  appointmentId: string;
  locked: boolean;
  /** There is a patient change to undo (see lib/veto.ts); without one, Veto is not offered. */
  canVeto: boolean;
  /** Smaller and wrapping, for a row on the Today board. */
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact ? "flex flex-wrap gap-2" : "flex flex-col gap-3 sm:flex-row"
      }
    >
      {locked ? (
        <ReasonDialog
          trigger={
            <>
              <LockOpenIcon aria-hidden /> Unlock
            </>
          }
          title="Unlock this appointment?"
          body="The patient will be able to change it again."
          confirm="Unlock appointment"
          run={(reason) => unlockAppointment(appointmentId, reason)}
        />
      ) : canVeto ? (
        <ReasonDialog
          trigger={
            <>
              <Undo2Icon aria-hidden /> Veto and lock
            </>
          }
          title="Undo the patient's last change?"
          body="Their most recent move or cancellation is reversed and the appointment is locked, so they cannot change it again until you unlock it."
          confirm="Veto and lock"
          run={(reason) => vetoAppointment(appointmentId, reason)}
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

function ReasonDialog({
  trigger,
  title,
  body,
  confirm,
  run,
}: {
  trigger: React.ReactNode;
  title: string;
  body: string;
  confirm: string;
  run: (reason: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function go() {
    start(async () => {
      const res = await run(reason);
      if (res.ok) {
        notify.success(res.message);
        setOpen(false);
        setReason("");
        router.refresh();
      } else {
        notify.error(res.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="staff-reason">Reason</Label>
          <Textarea
            id="staff-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={450}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button
            className="min-h-11"
            disabled={pending || reason.trim().length < 3}
            onClick={go}
          >
            {pending ? "Working" : confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

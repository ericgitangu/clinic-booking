"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { cancelAppointment } from "@/app/actions";
import { initialState } from "@/lib/action-state";
import {
  CHANGE_WINDOW_JUST_OPENED,
  CHANGE_WINDOW_NOTE,
  clockOffset,
  insideChangeWindow,
} from "@/lib/change-window";
import { forgetBooked } from "@/lib/own-bookings";
import { STAFF_LOCK_NOTE, STAFF_LOCK_TITLE } from "@/lib/staff-lock";
import { useActionFeedback } from "@/components/booking/use-action-feedback";
import { useRecaptcha } from "@/components/booking/use-recaptcha";

export function AppointmentActions({
  id,
  when,
  startsAt,
  serverNow,
  staffLocked = false,
}: {
  id: string;
  when: string;
  startsAt: string;
  /** The server's clock when the page was drawn: the screen reads time from it, not from the device. */
  serverNow: string;
  /** Staff vetoed and locked this visit: no change buttons at all, only the reason it is fixed. */
  staffLocked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [offset] = useState(() => clockOffset(serverNow, Date.now()));
  const [locked, setLocked] = useState(() =>
    insideChangeWindow(startsAt, Date.now() + offset),
  );
  const [justLocked, setJustLocked] = useState(false);
  const wasLocked = useRef(locked);
  // The window opens while the page is on screen: look again every 30 seconds. If a dialog is open
  // when it does, it closes and the screen says why, instead of the buttons just vanishing.
  useEffect(() => {
    const tick = () => {
      if (!insideChangeWindow(startsAt, Date.now() + offset)) return;
      if (!wasLocked.current) {
        wasLocked.current = true;
        setJustLocked(true);
      }
      setLocked(true);
      setOpen(false);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [startsAt, offset]);
  const [state, formAction, pending] = useActionState(
    cancelAppointment,
    initialState,
  );
  const getToken = useRecaptcha("cancel");
  const router = useRouter();
  const qc = useQueryClient();
  // Cancelled: that time is free again, so the grid must stop showing it as the patient's own.
  useActionFeedback(state, () => {
    setOpen(false);
    forgetBooked(qc, startsAt);
    // The appointment page now shows the cancelled view; the list drops the card.
    router.refresh();
  });
  // Another tab already cancelled it: the toast says so, then the list catches up.
  useEffect(() => {
    if (
      state.status === "error" &&
      state.code === "APPOINTMENT_ALREADY_CANCELLED"
    ) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  const reasonError =
    state.status === "error" ? state.fieldErrors?.reason : undefined;

  if (staffLocked) {
    return (
      <div className="mt-4" data-testid="staff-lock">
        <p className="text-base font-medium">{STAFF_LOCK_TITLE}</p>
        <p className="mt-1 text-base text-muted-foreground">
          {STAFF_LOCK_NOTE}
        </p>
      </div>
    );
  }

  if (locked) {
    const note = `change-note-${id}`;
    return (
      <div className="mt-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="h-11 px-4 text-base"
            disabled
            aria-describedby={note}
          >
            Reschedule
          </Button>
          <Button
            variant="outline"
            className="h-11 px-4 text-base"
            disabled
            aria-describedby={note}
          >
            Cancel
          </Button>
        </div>
        <p
          id={note}
          role={justLocked ? "alert" : undefined}
          className="mt-2 text-base text-muted-foreground"
        >
          {justLocked ? `${CHANGE_WINDOW_JUST_OPENED} ` : ""}
          {CHANGE_WINDOW_NOTE}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button asChild variant="outline" className="h-11 px-4 text-base">
        <Link href={`/appointments/${id}/reschedule`}>Reschedule</Link>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="h-11 px-4 text-base">
            Cancel
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this appointment?</DialogTitle>
            <DialogDescription>{when}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              fd.set("recaptcha_token", await getToken().catch(() => ""));
              startTransition(() => formAction(fd));
            }}
          >
            <input type="hidden" name="appointment_id" value={id} />
            <div className="space-y-2">
              <Label htmlFor={`reason-${id}`} className="text-base">
                Why are you cancelling?
              </Label>
              <Textarea
                id={`reason-${id}`}
                name="reason"
                required
                minLength={3}
                maxLength={500}
                rows={3}
                aria-invalid={Boolean(reasonError)}
                aria-describedby={
                  reasonError ? `reason-${id}-error` : undefined
                }
                className="text-base"
              />
              {reasonError ? (
                <p
                  id={`reason-${id}-error`}
                  className="text-base text-destructive"
                >
                  {reasonError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11 text-base"
                onClick={() => setOpen(false)}
              >
                Keep appointment
              </Button>
              <Button
                type="submit"
                className="h-11 text-base"
                disabled={pending}
              >
                {pending ? "Cancelling…" : "Cancel appointment"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarClockIcon, XIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@clinic/ui/components/ui/alert-dialog";
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
import { Input } from "@clinic/ui/components/ui/input";
import { Label } from "@clinic/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@clinic/ui/components/ui/select";
import { Textarea } from "@clinic/ui/components/ui/textarea";
import { notify } from "@clinic/ui/lib/notify";
import {
  cancelAppointment,
  loadSlots,
  rescheduleAppointment,
  type ActionResult,
} from "@/lib/actions";
import {
  CHANGE_WINDOW_JUST_OPENED,
  CHANGE_WINDOW_NOTE,
  clockOffset,
  insideChangeWindow,
} from "@/lib/change-window";
import { formatTime } from "@/lib/clinic-time";

function report(result: ActionResult): boolean {
  if (result.ok) notify.success(result.message);
  else notify.error(result.message);
  return result.ok;
}

// Cancel or move an appointment for a patient. The page only renders this for roles that may;
// the server action checks the role again.
export function AppointmentActions({
  appointmentId,
  doctorId,
  today,
  startsAt,
  serverNow,
}: {
  appointmentId: string;
  doctorId: string;
  today: string;
  startsAt: string;
  /** The server's clock when the page was drawn: the screen reads time from it, not the device. */
  serverNow: string;
}) {
  const [offset] = useState(() => clockOffset(serverNow, Date.now()));
  const [locked, setLocked] = useState(() =>
    insideChangeWindow(startsAt, Date.now() + offset),
  );
  const wasLocked = useRef(locked);
  // The window can open while the page is on screen: look again every 30 seconds. If it opens while
  // a dialog is up, the dialog goes with the buttons, so say why.
  useEffect(() => {
    const tick = () => {
      if (!insideChangeWindow(startsAt, Date.now() + offset)) return;
      if (!wasLocked.current) {
        wasLocked.current = true;
        notify.error(CHANGE_WINDOW_JUST_OPENED);
      }
      setLocked(true);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [startsAt, offset]);

  if (locked) {
    return (
      <div className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            className="min-h-11"
            disabled
            aria-describedby="change-note"
          >
            <CalendarClockIcon aria-hidden /> Reschedule
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            disabled
            aria-describedby="change-note"
          >
            <XIcon aria-hidden /> Cancel appointment
          </Button>
        </div>
        <p id="change-note" className="text-muted-foreground">
          {CHANGE_WINDOW_NOTE}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <RescheduleDialog
        appointmentId={appointmentId}
        doctorId={doctorId}
        today={today}
      />
      <CancelDialog appointmentId={appointmentId} />
    </div>
  );
}

function CancelDialog({ appointmentId }: { appointmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function confirm() {
    start(async () => {
      const ok = report(await cancelAppointment(appointmentId, reason));
      if (ok) {
        setOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" className="min-h-11">
          <XIcon aria-hidden /> Cancel appointment
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this appointment?</AlertDialogTitle>
          <AlertDialogDescription>
            The slot is released and the patient is not told automatically. Say
            why; it is kept with the appointment.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={450}
            rows={3}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-11"
            disabled={pending || reason.trim().length < 3}
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
          >
            {pending ? "Cancelling" : "Cancel appointment"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RescheduleDialog({
  appointmentId,
  doctorId,
  today,
}: {
  appointmentId: string;
  doctorId: string;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState("");
  const [pending, start] = useTransition();

  function pickDate(value: string) {
    setDate(value);
    setSlot("");
    setSlots(null);
    if (!value) return;
    start(async () => {
      const res = await loadSlots(doctorId, value);
      if (!res.ok) {
        notify.error(res.message);
        setSlots([]);
        return;
      }
      setSlots(res.slots.map((s) => s.startsAt));
    });
  }

  function confirm() {
    start(async () => {
      if (report(await rescheduleAppointment(appointmentId, slot))) {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          <CalendarClockIcon aria-hidden /> Reschedule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move this appointment</DialogTitle>
          <DialogDescription>
            Pick a day, then a free time with the same doctor.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="move-date">Day</Label>
            <Input
              id="move-date"
              type="date"
              min={today}
              value={date}
              onChange={(e) => pickDate(e.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="move-slot">Time</Label>
            <Select
              value={slot}
              onValueChange={setSlot}
              disabled={!slots?.length}
            >
              <SelectTrigger id="move-slot" className="min-h-11 w-full">
                <SelectValue
                  placeholder={
                    slots === null
                      ? "Pick a day first"
                      : slots.length === 0
                        ? "No free times that day"
                        : "Pick a time"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(slots ?? []).map((s) => (
                  <SelectItem key={s} value={s}>
                    {formatTime(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            className="min-h-11"
            disabled={pending || !slot}
            onClick={confirm}
          >
            {pending ? "Working" : "Move appointment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

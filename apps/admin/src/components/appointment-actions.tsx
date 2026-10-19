"use client";

import { useState, useTransition } from "react";
import { CalendarClockIcon, XIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import { Input } from "@clinic/ui/components/ui/input";
import { Label } from "@clinic/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@clinic/ui/components/ui/select";
import { notify } from "@clinic/ui/lib/notify";
import { ConfirmAction } from "@/components/confirm-action";
import {
  cancelAppointment,
  loadSlots,
  rescheduleAppointment,
} from "@/lib/actions";
import { formatTime } from "@/lib/clinic-time";

// Cancel or move an appointment for a patient, each through the one confirmation dialog. The page
// only renders this for roles that may; the server action checks the role again.
export function AppointmentActions({
  appointmentId,
  doctorId,
  today,
  compact = false,
}: {
  appointmentId: string;
  doctorId: string;
  today: string;
  /** Side by side and smaller, for a row on the Today board. */
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact ? "flex flex-wrap gap-2" : "flex flex-col gap-3 sm:flex-row"
      }
    >
      <RescheduleAction
        appointmentId={appointmentId}
        doctorId={doctorId}
        today={today}
      />
      <ConfirmAction
        trigger={
          <Button variant="destructive" className="min-h-11">
            <XIcon aria-hidden /> Cancel appointment
          </Button>
        }
        title="Cancel this appointment?"
        description="The slot is released and the patient is not told automatically. Say why; it is kept with the appointment."
        confirmLabel="Cancel appointment"
        run={(reason) => cancelAppointment(appointmentId, reason)}
      />
    </div>
  );
}

function RescheduleAction({
  appointmentId,
  doctorId,
  today,
}: {
  appointmentId: string;
  doctorId: string;
  today: string;
}) {
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState("");
  const [, start] = useTransition();

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

  return (
    <ConfirmAction
      trigger={
        <Button variant="outline" className="min-h-11">
          <CalendarClockIcon aria-hidden /> Reschedule
        </Button>
      }
      title="Move this appointment"
      description="Pick a day, then a free time with the same doctor. Say why; it is kept with the appointment."
      confirmLabel="Move appointment"
      extraReady={!!slot}
      run={(reason) => rescheduleAppointment(appointmentId, slot, reason)}
      onDone={() => {
        setDate("");
        setSlot("");
        setSlots(null);
      }}
      extra={
        <>
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
        </>
      }
    />
  );
}

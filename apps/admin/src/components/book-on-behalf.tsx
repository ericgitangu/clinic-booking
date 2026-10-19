"use client";

import { useState } from "react";
import { UserPlusIcon } from "lucide-react";
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
import { ConfirmAction } from "@/components/confirm-action";
import { bookOnBehalf } from "@/lib/actions";
import { formatSlot } from "@/lib/clinic-time";

// Book a patient who called or walked in into a free slot of this gap, through the one
// confirmation dialog. The reason is kept in the audit trail. Staff are not held to the booking lead
// time; the API still refuses a slot that was just taken.
export function BookOnBehalf({
  doctorId,
  doctorName,
  slots,
}: {
  doctorId: string;
  doctorName: string;
  slots: readonly string[];
}) {
  const [slot, setSlot] = useState(slots[0] ?? "");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  return (
    <ConfirmAction
      trigger={
        <Button variant="outline" className="min-h-11">
          <UserPlusIcon aria-hidden /> Book on behalf
        </Button>
      }
      title="Book for a patient"
      description={`With ${doctorName}. Say why you are booking for them; it is kept with the appointment.`}
      confirmLabel="Book appointment"
      extraReady={!!slot && name.trim().length >= 2}
      reasonHint="For example: patient phoned the front desk. At least 3 characters."
      run={(reason) =>
        bookOnBehalf({
          doctorId,
          startsAt: slot,
          reason,
          fullName: name,
          phone,
          email,
        })
      }
      onDone={() => {
        setName("");
        setPhone("");
        setEmail("");
      }}
      extra={
        <>
          <div className="space-y-2">
            <Label htmlFor="bob-slot">Time</Label>
            <Select value={slot} onValueChange={setSlot}>
              <SelectTrigger id="bob-slot" className="min-h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {slots.map((s) => (
                  <SelectItem key={s} value={s}>
                    {formatSlot(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bob-name">Patient name</Label>
            <Input
              id="bob-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              className="min-h-11"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="bob-phone">Phone (optional)</Label>
              <Input
                id="bob-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="off"
                className="min-h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bob-email">Email (optional)</Label>
              <Input
                id="bob-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                className="min-h-11"
              />
            </div>
          </div>
        </>
      }
    />
  );
}

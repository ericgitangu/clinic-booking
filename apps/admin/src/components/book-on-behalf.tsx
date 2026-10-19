"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UserPlusIcon } from "lucide-react";
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
import { bookOnBehalf } from "@/lib/actions";
import { formatSlot } from "@/lib/clinic-time";

// Book a patient who called or walked in into a free slot of this gap. A reason is required and
// kept in the audit trail. Staff are not held to the booking lead time; the API still refuses a
// slot that was just taken.
export function BookOnBehalf({
  doctorId,
  doctorName,
  slots,
}: {
  doctorId: string;
  doctorName: string;
  slots: readonly string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState(slots[0] ?? "");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await bookOnBehalf({
        doctorId,
        startsAt: slot,
        reason,
        fullName: name,
        phone,
        email,
      });
      if (res.ok) {
        notify.success(res.message);
        setOpen(false);
        setName("");
        setPhone("");
        setEmail("");
        setReason("");
        router.refresh();
      } else {
        notify.error(res.message);
      }
    });
  }

  const ready = !!slot && name.trim().length >= 2 && reason.trim().length >= 3;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          <UserPlusIcon aria-hidden /> Book on behalf
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book for a patient</DialogTitle>
          <DialogDescription>With {doctorName}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
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
          <div className="space-y-2">
            <Label htmlFor="bob-reason">Reason</Label>
            <Textarea
              id="bob-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={450}
              rows={2}
              placeholder="For example: patient phoned the front desk"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            className="min-h-11"
            disabled={pending || !ready}
            onClick={submit}
          >
            {pending ? "Booking" : "Book appointment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

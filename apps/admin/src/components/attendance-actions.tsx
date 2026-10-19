"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UserCheckIcon, UserXIcon } from "lucide-react";
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
import { markAttendance } from "@/lib/actions";

// Arrived and No-show for one visit, from 15 minutes before it starts to 2 hours after. A visit
// still unmarked is one tap. Changing a mark already made asks for a reason, which the API
// requires and keeps in the audit trail. The page only renders this for owner and admin and only
// inside the window; the API checks both again.
export function AttendanceActions({
  appointmentId,
  mark,
}: {
  appointmentId: string;
  mark: "booked" | "arrived" | "no_show";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function set(kind: "arrived" | "no_show", reason?: string) {
    start(async () => {
      const res = await markAttendance(appointmentId, kind, reason);
      if (res.ok) notify.success(res.message);
      else notify.error(res.message);
      if (res.ok) router.refresh();
    });
  }

  if (mark === "booked") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="min-h-11"
          disabled={pending}
          onClick={() => set("arrived")}
        >
          <UserCheckIcon aria-hidden /> Mark arrived
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={() => set("no_show")}
        >
          <UserXIcon aria-hidden /> Mark no-show
        </Button>
      </div>
    );
  }
  return (
    <ChangeMark
      to={mark === "arrived" ? "no_show" : "arrived"}
      pending={pending}
      onConfirm={(reason) =>
        set(mark === "arrived" ? "no_show" : "arrived", reason)
      }
    />
  );
}

function ChangeMark({
  to,
  pending,
  onConfirm,
}: {
  to: "arrived" | "no_show";
  pending: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const label = to === "arrived" ? "arrived" : "no-show";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="min-h-11">
          Change to {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change to {label}?</DialogTitle>
          <DialogDescription>
            This replaces the mark already made. Say why; it is kept in the
            audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="mark-reason">Reason</Label>
          <Textarea
            id="mark-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={450}
            rows={2}
          />
        </div>
        <DialogFooter>
          <Button
            className="min-h-11"
            disabled={pending || reason.trim().length < 3}
            onClick={() => {
              onConfirm(reason);
              setOpen(false);
              setReason("");
            }}
          >
            Change to {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

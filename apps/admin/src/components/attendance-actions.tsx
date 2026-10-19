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

const WORD = { arrived: "arrived", no_show: "no-show" } as const;

// Arrived and No-show for one visit, from 15 minutes before it starts to 2 hours after. Every mark
// is confirmed in a dialog, so a stray tap cannot record anything. The first mark may carry a note;
// changing a mark already made needs a reason of at least 3 characters, which the API requires and
// keeps in the audit trail. The page only renders this for owner and admin and only inside the
// window; the API checks both again.
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
        <MarkDialog appointmentId={appointmentId} to="arrived" change={false} />
        <MarkDialog appointmentId={appointmentId} to="no_show" change={false} />
      </div>
    );
  }
  return (
    <MarkDialog
      appointmentId={appointmentId}
      to={mark === "arrived" ? "no_show" : "arrived"}
      change
    />
  );
}

function MarkDialog({
  appointmentId,
  to,
  change,
}: {
  appointmentId: string;
  to: "arrived" | "no_show";
  /** True when it replaces a mark already made: then the reason is required. */
  change: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const word = WORD[to];
  const Icon = to === "arrived" ? UserCheckIcon : UserXIcon;
  const needed = change && reason.trim().length < 3;

  function confirm() {
    start(async () => {
      const res = await markAttendance(
        appointmentId,
        to,
        reason.trim() || undefined,
      );
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
        {change ? (
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
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {change ? `Change to ${word}?` : `Mark as ${word}?`}
          </DialogTitle>
          <DialogDescription>
            {change
              ? "This replaces the mark already made. Say why; it is kept in the audit trail."
              : `Record that the patient ${to === "arrived" ? "has arrived" : "did not show"}. It counts in the day's figures and is kept in the audit trail.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="mark-reason">
            {change ? "Reason" : "Note (optional)"}
          </Label>
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
            disabled={pending || needed}
            onClick={confirm}
          >
            {pending
              ? "Working"
              : change
                ? `Change to ${word}`
                : `Confirm ${word}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

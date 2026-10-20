"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import { followArrivalToast, WAITING_MS } from "@/lib/arrival-toast";
import { nextSerial } from "@/lib/live-notices";
import { forgetOwn, rememberOwn } from "@/lib/own-actions";
import type { ActionResult } from "@/lib/failure-copy";

export const MIN_REASON = 3;
export const MAX_REASON = 450;

/**
 * The one way a staff action is confirmed. Every action that changes something (mark arrived or
 * no-show, change a mark, cancel, reschedule, veto, unlock, book on behalf, revoke) opens this
 * dialog: the same layout (title, what will happen, any choices, the reason, Cancel and the action),
 * the same validation (a reason of at least 3 characters, which the API also requires and keeps in
 * the audit trail), and the same outcome (one toast with the action's own words, haptics through
 * notify, then the page refreshes). Nothing is recorded by opening it or by dismissing it.
 */
export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  run,
  extra,
  extraReady = true,
  withReason = true,
  reasonLabel = "Reason",
  reasonHint,
  onDone,
  ownsAppointment,
}: {
  /** The button that opens the dialog (a real button element, rendered as the trigger). */
  trigger: ReactNode;
  title: string;
  /** What will happen, in plain words. */
  description: string;
  /** The action's name; it is also the confirm button's. */
  confirmLabel: string;
  /** Calls the server action with the trimmed reason; the result becomes the toast. */
  run: (reason: string) => Promise<ActionResult>;
  /** Choices above the reason (a day and a time, a patient's name). */
  extra?: ReactNode;
  /** False until the choices in `extra` are complete. */
  extraReady?: boolean;
  /** False only where the API takes no reason (revoking access or an invitation). */
  withReason?: boolean;
  reasonLabel?: string;
  reasonHint?: string;
  onDone?: () => void;
  /** The appointment this changes: the live toast for the change is then left to this
   *  confirmation in this tab (other tabs, and other people, still get it). */
  ownsAppointment?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const text = reason.trim();
  const reasonOk = !withReason || text.length >= MIN_REASON;

  function go() {
    start(async () => {
      // Before the call: the live event can arrive before the answer does.
      if (ownsAppointment) rememberOwn(ownsAppointment);
      let res: ActionResult;
      try {
        res = await run(text);
      } catch (err) {
        // The call itself failed: nothing was changed that other people's events should wait on.
        if (ownsAppointment) forgetOwn(ownsAppointment);
        throw err;
      }
      if (res.ok) {
        // The change also touched other appointments (a veto of a cancel books a new one).
        for (const other of res.alsoOwns ?? []) rememberOwn(other);
        if (res.watch) {
          // One toast for the whole story: updated in place as the email to the doctor is sent.
          const id = `confirm-${nextSerial()}`;
          notify.success(res.message, { id, duration: WAITING_MS });
          void followArrivalToast(
            res.watch.appointmentId,
            id,
            (tid, message, kind, ms) =>
              notify[kind](message, { id: tid, duration: ms }),
          );
        } else {
          notify.success(res.message);
        }
        setOpen(false);
        setReason("");
        onDone?.();
        router.refresh();
      } else {
        if (ownsAppointment) forgetOwn(ownsAppointment);
        notify.error(res.message);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason("");
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {extra ? <div className="space-y-4">{extra}</div> : null}
        {withReason ? (
          <div className="space-y-2">
            <Label htmlFor="confirm-reason">{reasonLabel}</Label>
            <Textarea
              id="confirm-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={MAX_REASON}
              rows={3}
              aria-describedby="confirm-reason-hint"
            />
            <p
              id="confirm-reason-hint"
              className="text-sm text-muted-foreground"
            >
              {reasonHint ??
                "At least 3 characters. It is kept in the audit trail."}
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" className="min-h-11">
              Cancel
            </Button>
          </DialogClose>
          <Button
            className="min-h-11"
            disabled={pending || !reasonOk || !extraReady}
            onClick={go}
          >
            {pending ? "Working" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

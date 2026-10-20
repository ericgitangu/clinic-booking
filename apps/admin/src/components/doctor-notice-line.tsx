"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { retryDoctorEmail } from "@/lib/actions";
import type { DoctorNoticeView } from "@/lib/detail-read";
import {
  SHEET_RECHECK_AFTER_MS,
  watchDoctorNotice,
} from "@/lib/doctor-notice-read";
import { sheetLead, sheetLine } from "@/lib/doctor-notice-words";

/**
 * What became of the email to the doctor, on the appointment sheet: the time it went, or why it did
 * not, in plain words, with a lead that says "not notified" unless the doctor was. While it is on
 * its way the line looks again (2.5 s up to 140 s) and changes by itself, and only while this tab
 * is in front. A failed email, and a pending one nothing is sending, can be sent again by owner
 * and admin; asking twice sends once, because the API hands out the send once. Pending and
 * nothing sending means: never claimed and 2 minutes old (the send was cut off before it began), or
 * claimed and the 15 minute claim has run out (the sender died). Until the 15 minutes pass a
 * claimed row reads "on its way", and the looks stop at about 2 minutes, so a sheet left open
 * needs reopening to see that case: a named limit (README, the decisions page).
 */
export function DoctorNoticeLine({
  appointmentId,
  notice: first,
  canAct,
  reload,
}: {
  appointmentId: string;
  notice: DoctorNoticeView;
  canAct: boolean;
  reload: () => void;
}) {
  const [notice, setNotice] = useState(first);
  const [pending, start] = useTransition();
  const [asked, setAsked] = useState(false);

  useEffect(() => setNotice(first), [first]);
  useEffect(() => {
    if (first.status !== "pending" || first.retryable) return;
    let alive = true;
    // Looks until the row is final or can be sent again (2 minutes on, for an arrival nobody
    // claimed), and only while this tab is in front.
    void watchDoctorNotice(appointmentId, setNotice, {
      alive: () => alive,
      delays: SHEET_RECHECK_AFTER_MS,
      done: (n) => n.status !== "pending" || n.retryable,
    });
    return () => {
      alive = false;
    };
  }, [appointmentId, first]);

  const mayRetry = canAct && notice.retryable && !asked;
  return (
    <div
      className="space-y-2"
      data-testid="sheet-doctor-notice"
      data-status={notice.status}
      aria-live="polite"
    >
      <p className="text-sm">
        {sheetLead(notice) && (
          <>
            <span className="font-medium">{sheetLead(notice)}</span>{" "}
          </>
        )}
        {sheetLine(notice, mayRetry)}
      </p>
      {mayRetry && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await retryDoctorEmail(notice.id);
              if (res.ok) {
                setAsked(true);
                notify.info(res.message);
                setTimeout(reload, 3000);
              } else notify.error(res.message);
            })
          }
        >
          Send the email again
        </Button>
      )}
    </div>
  );
}

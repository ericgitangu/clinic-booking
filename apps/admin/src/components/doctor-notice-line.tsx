"use client";

import { useState, useTransition } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { retryDoctorEmail } from "@/lib/actions";
import type { DoctorNoticeView } from "@/lib/detail-read";
import { sheetLine } from "@/lib/doctor-notice-words";

/**
 * "Doctor notified" on the appointment sheet: the time it went, or why it did not, in plain words.
 * A failed email can be sent again by owner and admin; asking twice sends once (the API hands out
 * the send once).
 */
export function DoctorNoticeLine({
  notice,
  canAct,
  reload,
}: {
  notice: DoctorNoticeView;
  canAct: boolean;
  reload: () => void;
}) {
  const [pending, start] = useTransition();
  const [asked, setAsked] = useState(false);
  const mayRetry = canAct && notice.status === "failed" && notice.attempts < 3;
  return (
    <div
      className="space-y-2"
      data-testid="sheet-doctor-notice"
      data-status={notice.status}
    >
      <p className="text-sm">
        <span className="font-medium">Doctor notified.</span>{" "}
        {sheetLine(notice)}
      </p>
      {mayRetry && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={pending || asked}
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

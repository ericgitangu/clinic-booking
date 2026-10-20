"use client";

import { useEffect, useRef } from "react";
import { notify } from "@clinic/ui/lib/notify";
import { doctorEmailSuffix } from "@/lib/doctor-notice-read";
import { parseLiveEvent } from "@/lib/live-events";
import {
  ToastBatcher,
  cardsTouched,
  highlights,
  toastText,
  wantsEmailStatus,
  type ToastSink,
} from "@/lib/live-notices";
import { sharedStream } from "@/lib/live-share";
import type { Role } from "@/lib/roles";

const SUMMARY_MS = 6000;
// An arrival toast stays up long enough to be updated with what became of the doctor's email.
const ARRIVAL_MS = 6000;

/** Toasts through the shared notify setup: quiet (no buzz, no sound) and loaded on the first one. */
const sink = (): ToastSink => {
  let n = 0;
  return {
    show: (text) => {
      const id = `live-${(n += 1)}`;
      notify.quiet(text, { id, duration: ARRIVAL_MS });
      return id;
    },
    update: (id, text) => notify.quiet(text, { id, duration: ARRIVAL_MS }),
    dismiss: (id) => notify.dismiss(id),
    summary: (id, text) => notify.quiet(text, { id, duration: SUMMARY_MS }),
  };
};

/**
 * Draws attention to what happens while nobody is watching the feed panel: a toast for each live
 * event (a burst of more than three becomes one "N updates"), and a mark on the doctor's card on
 * the today board. It renders nothing and opens no stream: it listens to the one the browser
 * shares (live-share.ts). What it is given is already shaped for the role by the gateway and
 * checked again by parseLiveEvent, so a viewer's toast never has a name in it. Events replayed
 * after a resume (the `replay` flag) are not announced: they happened while the person was away.
 */
export function LiveNotifications({
  role,
  person,
  doctors,
}: {
  role: Role;
  /** The per-person key the tabs share their stream under (liveKey). */
  person: string;
  doctors: { id: string; name: string }[];
}) {
  // The page hands a new array on every render; the subscription reads the latest one without
  // being torn down for it.
  const latest = useRef(doctors);
  useEffect(() => {
    latest.current = doctors;
  });
  useEffect(() => {
    const batch = new ToastBatcher(sink());
    return sharedStream(person).subscribe({
      role,
      onStatus: () => undefined,
      onRefresh: () => undefined,
      onEvent: (_id, _event, data, replay) => {
        if (replay) return;
        const ev = parseLiveEvent(data, role);
        if (!ev) return;
        for (const key of cardsTouched(ev)) highlights.mark(key);
        const doctor = latest.current.find((d) => d.id === ev.doctorId)?.name;
        if (!isToastKind(ev.kind)) return;
        // Owner and admin hear what became of the email to the doctor; a viewer's stream carries
        // no names, and nothing about the doctor's address either.
        const follow =
          wantsEmailStatus(ev, role) && ev.appointmentId
            ? (add: (suffix: string) => void) =>
                void doctorEmailSuffix(ev.appointmentId as string, add)
            : undefined;
        batch.push(toastText(ev, doctor, role), follow);
      },
    });
  }, [person, role]);
  return null;
}

function isToastKind(kind: string): boolean {
  return !kind.startsWith("invite_");
}

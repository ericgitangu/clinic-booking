"use client";

import { useEffect, useRef } from "react";
import { notify } from "@clinic/ui/lib/notify";
import { doctorEmailSuffix } from "@/lib/doctor-notice-read";
import { isOwnChange, parseLiveEvent } from "@/lib/live-events";
import {
  ToastBatcher,
  cardsTouched,
  highlights,
  nextSerial,
  toastText,
  wantsEmailStatus,
  type ToastSink,
} from "@/lib/live-notices";
import { sharedStream } from "@/lib/live-share";
import type { Role } from "@/lib/roles";

const SUMMARY_MS = 6000;
const TOAST_MS = 6000;
// A colleague's arrival toast, still waiting for the email, stays up past its last look (15 s).
const WAITING_MS = 17_000;

/** Toasts through the shared notify setup: quiet (no buzz, no sound) and loaded on the first one.
 *  Ids come from one counter for the page, so a toast of an earlier mount is never overwritten. */
const sink = (): ToastSink => ({
  show: (text, gone) => {
    const id = `live-${nextSerial()}`;
    notify.quiet(text, {
      id,
      duration: TOAST_MS,
      onDismiss: gone,
      onAutoClose: gone,
    });
    return id;
  },
  update: (id, text, gone) =>
    notify.quiet(text, {
      id,
      duration: text.endsWith("on its way") ? WAITING_MS : TOAST_MS,
      onDismiss: gone,
      onAutoClose: gone,
    }),
  dismiss: (id) => notify.dismiss(id),
  summary: (id, text) => notify.quiet(text, { id, duration: SUMMARY_MS }),
});

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
  self,
  doctors,
}: {
  role: Role;
  /** The signed-in person's own address, as the gateway writes an actor's: lower case. */
  self: string;
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
    const off = sharedStream(person).subscribe({
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
        // A change the signed-in person made is theirs: they have its confirmation, and a second
        // toast would also count towards a burst and fold colleagues' updates away. It is known
        // by who did it, which the event itself carries (owner and admin only: a viewer's events
        // name nobody, and a viewer changes nothing), so it holds whichever tab made the change,
        // whenever the event arrives, and for a veto's new appointment as well as the same one.
        if (isOwnChange(ev, self)) return;
        // Owner and admin hear what became of the email to the doctor; a viewer's stream carries
        // no names, and nothing about the doctor's address either.
        const follow =
          wantsEmailStatus(ev, role, document.hidden) && ev.appointmentId
            ? (add: (suffix: string) => void, alive: () => boolean) =>
                void doctorEmailSuffix(ev.appointmentId as string, add, alive)
            : undefined;
        batch.push(toastText(ev, doctor, role), follow);
      },
    });
    return () => {
      off();
      batch.dispose();
    };
  }, [person, role, self]);
  return null;
}

// Invitations and passes are access changes, not clinic activity: they go to the feed, not a toast.
export function isToastKind(kind: string): boolean {
  return !kind.startsWith("invite_") && !kind.startsWith("pass_");
}

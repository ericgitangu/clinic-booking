"use client";

import { useEffect, useRef } from "react";
import { notify } from "@clinic/ui/lib/notify";
import { parseLiveEvent } from "@/lib/live-events";
import {
  ToastBatcher,
  cardsTouched,
  highlights,
  toastText,
  type ToastSink,
} from "@/lib/live-notices";
import { sharedStream } from "@/lib/live-share";
import type { Role } from "@/lib/roles";

const SUMMARY_MS = 6000;

/** Toasts through the shared notify setup: quiet (no buzz, no sound) and loaded on the first one. */
const sink = (): ToastSink => {
  let n = 0;
  return {
    show: (text) => {
      const id = `live-${(n += 1)}`;
      notify.quiet(text, { id });
      return id;
    },
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
        batch.push(toastText(ev, doctor, role));
      },
    });
  }, [person, role]);
  return null;
}

function isToastKind(kind: string): boolean {
  return !kind.startsWith("invite_");
}

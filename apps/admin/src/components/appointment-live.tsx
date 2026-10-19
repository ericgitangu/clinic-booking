"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { concernsAppointment, parseLiveEvent } from "@/lib/live-events";
import { sharedStream } from "@/lib/live-share";
import type { LiveStatus } from "@/lib/live-stream";
import type { Role } from "@/lib/roles";

const TEXT: Record<LiveStatus, string> = {
  connecting: "Connecting to live updates",
  live: "Live: changes to this appointment appear here",
  paused: "Live updates paused",
  busy: "Live updates busy, refreshing every 30 s",
  offline: "Offline, retrying. Refreshing every 30 s",
  denied: "Live updates unavailable. Reload the page",
};

/**
 * Keeps an open appointment page current. It opens no stream of its own: it listens to the one
 * stream the browser shares (live-share.ts), keeps the events about this appointment
 * (concernsAppointment) and refreshes the server-rendered history and actions when one arrives
 * (events within 300 ms share one refresh).
 *
 * It used to hold a stream filtered on the gateway (`?appointment=<id>`). With the dashboard open
 * in another tab that was a second stream for one person, and with two Cloud Run instances that is
 * the whole service (2026-10-19). The shared stream is the one the dashboard reads, shaped for the
 * role by the gateway, so filtering it here shows the page nothing the dashboard would not.
 */
export function AppointmentLive({
  appointmentId,
  doctorId,
  role,
  person,
}: {
  appointmentId: string;
  doctorId: string;
  role: Role;
  /** The per-person key the tabs share their stream under (liveKey). */
  person: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [, start] = useTransition();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => start(() => router.refresh());
    const appt = { id: appointmentId, doctorId };
    const off = sharedStream(person).subscribe({
      role,
      onStatus: setStatus,
      onRefresh: refresh,
      onEvent: (_id, _event, data) => {
        const ev = parseLiveEvent(data, role);
        if (!ev || !concernsAppointment(ev, appt, role)) return;
        setUpdatedAt(new Date().toISOString());
        if (pending.current === null) {
          pending.current = setTimeout(() => {
            pending.current = null;
            refresh();
          }, 300);
        }
      },
    });
    return () => {
      off();
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [appointmentId, doctorId, person, role, router]);

  return (
    <p
      data-testid="appointment-live"
      data-status={status}
      data-updated-at={updatedAt ?? ""}
      role="status"
      className="inline-flex items-center gap-2 text-sm text-muted-foreground"
    >
      <span
        aria-hidden
        className={
          status === "live"
            ? "size-2 rounded-full bg-emerald-500"
            : status === "connecting"
              ? "size-2 animate-pulse rounded-full bg-amber-500"
              : "size-2 rounded-full bg-muted-foreground/50"
        }
      />
      {TEXT[status]}
    </p>
  );
}

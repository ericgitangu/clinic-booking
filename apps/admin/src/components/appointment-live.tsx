"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { parseLiveEvent } from "@/lib/live-events";
import { LiveStream, type LiveStatus } from "@/lib/live-stream";
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
 * Keeps an open appointment page current. It holds ONE stream, filtered on the gateway to this
 * appointment (`?appointment=<id>`, signed into the assertion like the cursor), and refreshes the
 * server-rendered history and actions when an event for it arrives (events within 300 ms
 * share one refresh).
 *
 * Why a filtered stream of its own rather than sharing the dashboard's: the two never live in the
 * same tab (navigating away unmounts the dashboard's feed), so one stream per page is still one
 * stream per tab, and the filter keeps every other appointment's events off this page's wire.
 * It counts against the same budget (one stream per person, two Cloud Run instances): with the
 * dashboard open in another tab it is refused and falls back to refreshing every 30 s.
 */
export function AppointmentLive({
  appointmentId,
  role,
}: {
  appointmentId: string;
  role: Role;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [, start] = useTransition();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => start(() => router.refresh());
    const s = new LiveStream({
      appointment: appointmentId,
      isHidden: () => document.hidden,
      onStatus: setStatus,
      onRefresh: refresh,
      onEvent: (_id, _event, data) => {
        if (!parseLiveEvent(data, role)) return;
        setUpdatedAt(new Date().toISOString());
        if (pending.current === null) {
          pending.current = setTimeout(() => {
            pending.current = null;
            refresh();
          }, 300);
        }
      },
    });
    s.start();
    const onVisibility = () => s.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
      s.stop();
    };
  }, [appointmentId, role, router]);

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

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  CalendarClockIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  RadioIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@clinic/ui/components/ui/card";
import { Button } from "@clinic/ui/components/ui/button";
import { refreshMetrics } from "@/lib/actions";
import {
  addEvent,
  canSeePeople,
  describe,
  parseLiveEvent,
  type LiveEvent,
  type LiveKind,
} from "@/lib/live-events";
import { LiveStream, type LiveStatus } from "@/lib/live-stream";
import type { Role } from "@/lib/roles";

const ICON: Record<LiveKind, typeof RadioIcon> = {
  booked: CalendarPlusIcon,
  rescheduled: CalendarClockIcon,
  cancelled: CalendarXIcon,
};

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  paused: "Paused",
  busy: "Live feed busy, refreshing every 30 s",
  offline: "Offline, retrying. Refreshing every 30 s",
  denied: "Your access changed. Reload the page",
};

/**
 * Bookings, reschedules and cancellations as they happen. The numbers above and the list below
 * follow: each event asks for a fresh page, at most once every two seconds.
 *
 * The stream is held open only while it is useful: a tab hidden for five minutes lets go of it, the
 * server lets go of one that has been quiet for four, and both wait for the person to come back.
 * If the gateway has no free slot the panel says so and the page refreshes by itself instead.
 */
export function LiveFeed({
  role,
  doctors,
}: {
  role: Role;
  doctors: { id: string; name: string }[];
}) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [, start] = useTransition();
  const stream = useRef<LiveStream | null>(null);
  const refreshAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const names = new Map(doctors.map((d) => [d.id, d.name]));

  const refresh = useCallback(() => {
    start(async () => {
      await refreshMetrics();
    });
  }, []);

  useEffect(() => {
    const s = new LiveStream({
      isHidden: () => document.hidden,
      onStatus: setStatus,
      onRefresh: refresh,
      onEvent: (_id, _event, data) => {
        const ev = parseLiveEvent(data, role);
        if (!ev) return;
        setEvents((list) => addEvent(list, ev));
        if (refreshAt.current === null) {
          refreshAt.current = setTimeout(() => {
            refreshAt.current = null;
            refresh();
          }, 2000);
        }
      },
    });
    stream.current = s;
    s.start();
    const onVisibility = () => s.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (refreshAt.current !== null) clearTimeout(refreshAt.current);
      refreshAt.current = null;
      s.stop();
      stream.current = null;
    };
  }, [role, refresh]);

  return (
    <Card data-testid="live-feed">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="font-heading text-lg">Live feed</CardTitle>
          <div className="flex items-center gap-2">
            <span
              data-testid="live-status"
              data-status={status}
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
              {STATUS_TEXT[status]}
            </span>
            {status === "paused" && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                data-testid="live-resume"
                onClick={() => stream.current?.resume()}
              >
                Resume live
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          {canSeePeople(role)
            ? "New bookings, reschedules and cancellations, with the patient."
            : "New bookings, reschedules and cancellations. Patient details are not shown to viewers."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-muted-foreground" data-testid="live-empty">
            {status === "live"
              ? "Waiting for the next booking."
              : "Nothing yet. Changes appear here once the feed is live."}
          </p>
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {events.map((ev) => {
              const Icon = ICON[ev.kind];
              const text = describe(ev, names.get(ev.doctorId), role);
              return (
                <li
                  key={ev.seq}
                  data-testid="live-event"
                  data-kind={ev.kind}
                  className="flex items-start gap-3"
                >
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {ev.appointmentId ? (
                    <Link
                      className="underline-offset-4 hover:underline"
                      href={`/dashboard/appointments/${ev.appointmentId}`}
                    >
                      {text}
                    </Link>
                  ) : (
                    <span>{text}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

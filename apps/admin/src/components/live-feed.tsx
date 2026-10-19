"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  BellRingIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  ClockAlertIcon,
  LockIcon,
  LockOpenIcon,
  MailCheckIcon,
  MailIcon,
  MailXIcon,
  RadioIcon,
  UserCheckIcon,
  UserXIcon,
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
import { sharedStream } from "@/lib/live-share";
import type { LiveStatus } from "@/lib/live-stream";
import type { Role } from "@/lib/roles";

const ICON: Record<LiveKind, typeof RadioIcon> = {
  booked: CalendarPlusIcon,
  rescheduled: CalendarClockIcon,
  cancelled: CalendarXIcon,
  vetoed: LockIcon,
  unlocked: LockOpenIcon,
  arrived: UserCheckIcon,
  no_show: UserXIcon,
  reminder_now: BellRingIcon,
  running_late: ClockAlertIcon,
  invite_created: MailIcon,
  invite_revoked: MailXIcon,
  invite_accepted: MailCheckIcon,
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
 * Bookings, reschedules, cancellations and staff actions (vetoes, attendance, reminders,
 * invitations) as they happen. The numbers above and the list below
 * follow: each event asks for a fresh page, at most once every two seconds.
 *
 * Every tab of the browser shares one stream (live-share.ts), so this panel next to an open
 * appointment page costs no second slot. The stream is held open only while it is useful: a tab
 * hidden for five minutes lets go of it, the server lets go of one that has been quiet for four,
 * and both wait for the person to come back. If the gateway has no free slot the panel says so,
 * the page refreshes by itself every 30 s, and the stream is tried again with a growing delay.
 */
export function LiveFeed({
  role,
  person,
  doctors,
}: {
  role: Role;
  /** The per-person key the tabs share their stream under (liveKey). */
  person: string;
  doctors: { id: string; name: string }[];
}) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [, start] = useTransition();
  const refreshAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const names = new Map(doctors.map((d) => [d.id, d.name]));

  const refresh = useCallback(() => {
    start(async () => {
      await refreshMetrics();
    });
  }, []);

  useEffect(() => {
    const off = sharedStream(person).subscribe({
      role,
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
    return () => {
      off();
      if (refreshAt.current !== null) clearTimeout(refreshAt.current);
      refreshAt.current = null;
    };
  }, [person, role, refresh]);

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
                onClick={() => sharedStream(person).resume()}
              >
                Resume live
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          {canSeePeople(role)
            ? "Bookings, changes and staff actions, with the patient, who acted and why."
            : "Bookings, changes and staff actions. Patient and staff details are not shown to viewers."}
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
              const text = describe(
                ev,
                ev.doctorId ? names.get(ev.doctorId) : undefined,
                role,
              );
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

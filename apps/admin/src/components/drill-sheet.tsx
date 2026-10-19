"use client";

import Link from "next/link";
import {
  useCallback,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { Button } from "@clinic/ui/components/ui/button";
import { Input } from "@clinic/ui/components/ui/input";
import { Label } from "@clinic/ui/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@clinic/ui/components/ui/sheet";
import { Skeleton } from "@clinic/ui/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { formatSlot } from "@/lib/clinic-time";
import {
  applyDrill,
  leadHours,
  type DrillConfig,
  type DrillRow,
  type StatusChoice,
} from "@/lib/drill";
import { loadDrill, type DrillResult } from "@/lib/drill-actions";
import { formatLead } from "@/lib/kpi-delta";
import { shownName } from "@/lib/shown-name";

const CHOICES: readonly { value: StatusChoice; label: string }[] = [
  { value: "all", label: "All" },
  { value: "booked", label: "Booked" },
  { value: "arrived", label: "Arrived" },
  { value: "no_show", label: "No-show" },
  { value: "cancelled", label: "Cancelled" },
];

const SELECT =
  "min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// The appointments behind a number or a section, in a sheet that rises from the bottom (so it is a
// proper bottom sheet on a phone and a wide panel on a desktop). The list is read from the API when
// it opens, starts as exactly what the card promised, and can be narrowed by status, doctor and
// date. The count above it is the count of the rows below it. Focus is trapped inside while it is
// open, Esc closes it and focus goes back to what opened it (the sheet is a Radix dialog).
export function DrillSheet({
  config,
  className,
  label,
  children,
}: {
  config: DrillConfig;
  /** Classes for the trigger button. */
  className?: string;
  /** Names the button for assistive technology when its content is only a number. */
  label?: string;
  /** What the trigger shows. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Extract<DrillResult, { ok: true }> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(config.spec.from);
  const [to, setTo] = useState(config.spec.to);
  const [status, setStatus] = useState<StatusChoice>(config.visit ?? "all");
  const [doctorId, setDoctorId] = useState(config.spec.doctorId ?? "");
  const [pending, start] = useTransition();

  const read = useCallback(
    (f: string, t: string) => {
      start(async () => {
        const res = await loadDrill({
          ...config.spec,
          from: f,
          to: t,
          doctorId: undefined,
        });
        if (res.ok) {
          setData(res);
          setError(null);
        } else {
          setError(res.message);
        }
      });
    },
    [config.spec],
  );

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setFrom(config.spec.from);
      setTo(config.spec.to);
      setStatus(config.visit ?? "all");
      setDoctorId(config.spec.doctorId ?? "");
      setData(null);
      read(config.spec.from, config.spec.to);
    }
  }

  const rows = useMemo(
    () =>
      data
        ? applyDrill(data.rows, config, { status, doctorId }, data.nowMs)
        : [],
    [data, config, status, doctorId],
  );
  const doctors = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data?.rows ?? []) m.set(r.doctor_id, r.doctor_name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={className}
          aria-haspopup="dialog"
        >
          {children}
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[88dvh] w-full gap-3 overflow-hidden rounded-t-2xl p-0 sm:max-w-3xl"
      >
        <SheetHeader className="px-4 pt-4 pr-12">
          <SheetTitle className="font-heading text-lg">
            {config.title}
          </SheetTitle>
          <SheetDescription>{config.description}</SheetDescription>
        </SheetHeader>

        <div className="grid gap-3 px-4 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="drill-status">Status</Label>
            <select
              id="drill-status"
              className={SELECT}
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusChoice)}
            >
              {CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="drill-doctor">Doctor</Label>
            <select
              id="drill-doctor"
              className={SELECT}
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
            >
              <option value="">All doctors</option>
              {doctors.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="drill-from">From</Label>
            <Input
              id="drill-from"
              type="date"
              value={from}
              max={to}
              className="min-h-11"
              onChange={(e) => {
                setFrom(e.target.value);
                if (e.target.value && e.target.value < to)
                  read(e.target.value, to);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="drill-to">Before</Label>
            <Input
              id="drill-to"
              type="date"
              value={to}
              min={from}
              className="min-h-11"
              onChange={(e) => {
                setTo(e.target.value);
                if (e.target.value && e.target.value > from)
                  read(from, e.target.value);
              }}
            />
          </div>
        </div>

        <p
          className="px-4 text-sm font-medium tabular-nums"
          role="status"
          aria-live="polite"
          data-testid="drill-count"
          data-count={data ? rows.length : ""}
        >
          {data
            ? `${rows.length} ${rows.length === 1 ? "visit" : "visits"}`
            : pending
              ? "Loading"
              : ""}
          {data?.truncated ? ". The list is cut at 500; narrow the dates." : ""}
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-border p-4 text-sm"
            >
              {error}{" "}
              <Button
                variant="outline"
                className="ml-2 min-h-11"
                onClick={() => read(from, to)}
              >
                Try again
              </Button>
            </p>
          ) : !data ? (
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
            </div>
          ) : rows.length === 0 ? (
            <p
              className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground"
              data-testid="drill-empty"
            >
              No visits match. Widen the dates or choose All.
            </p>
          ) : (
            <ul
              className="divide-y divide-border rounded-lg border border-border"
              data-testid="drill-list"
            >
              {rows.map((r) => (
                <DrillItem
                  key={r.id}
                  r={r}
                  view={data.view}
                  lead={config.showLead}
                />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DrillItem({
  r,
  view,
  lead,
}: {
  r: DrillRow;
  view: "full" | "minimised";
  lead?: boolean;
}) {
  return (
    <li>
      <Link
        href={`/dashboard/appointments/${r.id}`}
        className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <span aria-hidden="true" className="contents">
          <DoctorAvatar doctorId={r.doctor_id} name={r.doctor_name} size={32} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {shownName(r.patient_name, view)}
          </span>
          <span className="block truncate text-sm text-muted-foreground tabular-nums">
            {formatSlot(r.starts_at)}, {r.doctor_name}
            {lead ? `, booked ${formatLead(leadHours(r))} ahead` : ""}
          </span>
        </span>
        <StatusBadge status={r.status} attendance={r.attendance} />
      </Link>
    </li>
  );
}

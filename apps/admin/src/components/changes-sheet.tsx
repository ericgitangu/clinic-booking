"use client";

import { useCallback, useState, useTransition, type ReactNode } from "react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { Button } from "@clinic/ui/components/ui/button";
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
import { AppointmentLink } from "@/components/appointment-sheet";
import { StatusBadge } from "@/components/status-badge";
import type { ChangeKind, ChangeRow, ChangesResult } from "@/lib/changes";
import { formatSlot } from "@/lib/clinic-time";
import { shownName } from "@/lib/shown-name";

export interface ChangeOption {
  kind: ChangeKind;
  label: string;
  /** The number the figure shows for this kind, which the sheet's count must equal. */
  expected: number;
  /** Cancelled only: the reason group, as /ops/cancellation-reasons names it. */
  reason?: string;
}

const SELECT =
  "min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-64";

// The visits behind a figure the API gives as a count: moves, cancellations by reason, the activity of
// a day. The list comes from the changes read (contract in lib/changes.ts) and starts as exactly the
// number on the card. While that read does not exist, the sheet shows the numbers it has and says
// plainly what is missing, so the gap is named where a person looks for the list. Same sheet pattern
// as every other detail view; viewers get the API's projection and no actions.
export function ChangesSheet({
  title,
  description,
  className,
  trigger,
  options,
  range,
  canAct,
  figure,
  gap,
}: {
  title: string;
  description: string;
  className?: string;
  trigger: ReactNode;
  options: readonly ChangeOption[];
  range: { from: string; to: string };
  canAct: boolean;
  /** The numbers the page already has, shown when the list cannot be. */
  figure: ReactNode;
  gap: string;
}) {
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState(0);
  const [data, setData] = useState<ChangesResult | null>(null);
  const [, start] = useTransition();
  const opt = options[which] ?? options[0]!;

  const read = useCallback(
    (o: ChangeOption) => {
      setData(null);
      start(async () => {
        const q = new URLSearchParams({
          kind: o.kind,
          from: range.from,
          to: range.to,
        });
        if (o.reason) q.set("reason", o.reason);
        try {
          setData(
            (await (
              await fetch(`/dashboard/read/changes?${q.toString()}`, {
                cache: "no-store",
              })
            ).json()) as ChangesResult,
          );
        } catch {
          setData({
            ok: false,
            message: "The clinic service did not answer. Try again.",
          });
        }
      });
    },
    [range.from, range.to],
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setWhich(0);
          read(options[0]!);
        }
      }}
    >
      <SheetTrigger asChild>
        <button type="button" aria-haspopup="dialog" className={className}>
          {trigger}
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[88dvh] w-full gap-3 overflow-hidden rounded-t-2xl p-0 sm:max-w-3xl"
      >
        <SheetHeader className="px-4 pt-4 pr-12">
          <SheetTitle className="font-heading text-lg">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {options.length > 1 && (
          <div className="space-y-1 px-4">
            <Label htmlFor="changes-kind">What</Label>
            <select
              id="changes-kind"
              className={SELECT}
              value={which}
              onChange={(e) => {
                const i = Number(e.target.value);
                setWhich(i);
                read(options[i]!);
              }}
            >
              {options.map((o, i) => (
                <option key={o.kind} value={i}>
                  {o.label} ({o.expected})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
          {data === null ? (
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
            </div>
          ) : data.ok ? (
            <>
              <p
                className="text-sm font-medium tabular-nums"
                role="status"
                aria-live="polite"
                data-testid="changes-count"
                data-count={data.total}
              >
                {data.truncated
                  ? `Showing ${data.rows.length} of ${data.total}. Narrow the dates to see the rest.`
                  : `${data.total} ${data.total === 1 ? "change" : "changes"}`}
              </p>
              {data.rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
                  Nothing of this kind in these days.
                </p>
              ) : (
                <ul
                  className="divide-y divide-border rounded-lg border border-border"
                  data-testid="changes-list"
                >
                  {data.rows.map((r, i) => (
                    <ChangeItem
                      key={`${r.appointment_id}-${r.occurred_at}-${i}`}
                      r={r}
                      view={data.view}
                      canAct={canAct}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : data.notBuilt ? (
            <>
              <div data-testid="figure-numbers">{figure}</div>
              <p
                className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground"
                data-testid="figure-gap"
              >
                {gap}
              </p>
            </>
          ) : (
            <p
              role="alert"
              className="rounded-lg border border-border p-4 text-sm"
            >
              {data.message}{" "}
              <Button
                variant="outline"
                className="ml-2 min-h-11"
                onClick={() => read(opt)}
              >
                Try again
              </Button>
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChangeItem({
  r,
  view,
  canAct,
}: {
  r: ChangeRow;
  view: "full" | "minimised";
  canAct: boolean;
}) {
  const verb =
    r.kind === "booked"
      ? "Booked"
      : r.kind === "rescheduled"
        ? "Moved"
        : "Cancelled";
  return (
    <li>
      <AppointmentLink
        id={r.appointment_id}
        canAct={canAct}
        className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <span aria-hidden="true" className="contents">
          <DoctorAvatar doctorId={r.doctor_id} name={r.doctor_name} size={32} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {shownName(r.patient_name, view)}
          </span>
          <span className="block text-sm text-muted-foreground">
            {verb} {formatSlot(r.occurred_at)}
            {r.actor
              ? `, by ${r.actor === "staff" ? "staff" : "the patient"}`
              : ""}
            {r.kind === "rescheduled" && r.from_starts_at && r.to_starts_at
              ? `, ${formatSlot(r.from_starts_at)} to ${formatSlot(r.to_starts_at)}`
              : ""}
          </span>
          {r.reason ? (
            <span className="block text-sm">Reason: {r.reason}</span>
          ) : view === "minimised" && r.kind !== "booked" ? (
            <span className="block text-sm text-muted-foreground">
              Reason on record: hidden for your role.
            </span>
          ) : null}
        </span>
        <StatusBadge status={r.status} attendance={r.attendance} />
      </AppointmentLink>
    </li>
  );
}

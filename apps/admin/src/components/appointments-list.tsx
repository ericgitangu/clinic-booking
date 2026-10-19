import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { Button } from "@clinic/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@clinic/ui/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { formatSlot } from "@/lib/clinic-time";
import type { StatusFilterValue } from "@/lib/filters";
import { shownName } from "@/lib/shown-name";
import type { AdminAppointment } from "@clinic/api/generated";

const EMPTY: Record<StatusFilterValue, { title: string; hint: string }> = {
  all: {
    title: "No appointments yet",
    hint: "When a patient books on the patient site, the visit shows up here.",
  },
  booked: {
    title: "Nothing is booked",
    hint: "Every visit on the list has been cancelled, or none were made.",
  },
  cancelled: {
    title: "No cancellations",
    hint: "Cancelled visits would appear here with the reason.",
  },
};

const rowLabel = (a: AdminAppointment, view: "full" | "minimised") =>
  `${shownName(a.patient_name, view)}, ${formatSlot(a.starts_at)}, ${a.status}`;

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// A table from md up, a stack of cards below it: a phone cannot hold five columns, and a card
// is one large tap target per appointment. Either way the whole row opens the appointment.
export function AppointmentsList({
  items,
  view = "full",
  status,
  nextHref,
  firstHref,
}: {
  items: readonly AdminAppointment[];
  view?: "full" | "minimised";
  status: StatusFilterValue;
  nextHref: string | null;
  firstHref: string | null;
}) {
  if (items.length === 0) {
    const e = EMPTY[status];
    return (
      <div
        className="rounded-xl border border-dashed border-border p-8 text-center"
        data-testid="appointments-empty"
      >
        <p className="font-medium">{e.title}</p>
        <p className="mt-1 text-muted-foreground">{e.hint}</p>
        {firstHref && (
          <Button asChild variant="outline" className="mt-4 min-h-11">
            <Link href={firstHref}>Back to latest</Link>
          </Button>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="hidden md:block">
        <Table data-testid="appointments-table">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Patient</TableHead>
              <TableHead>Doctor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow
                key={a.id}
                className="relative has-[a:focus-visible]:bg-muted/60"
              >
                <TableCell className="tabular-nums">
                  {formatSlot(a.starts_at)}
                </TableCell>
                <TableCell className="font-medium">
                  {/* The link's ::after covers the row, so a click anywhere on it opens it. */}
                  <Link
                    href={`/dashboard/appointments/${a.id}`}
                    data-row-link
                    data-row-label={rowLabel(a, view)}
                    className={`rounded-sm after:absolute after:inset-0 ${FOCUS}`}
                  >
                    {shownName(a.patient_name, view)}
                    <span className="sr-only">{`, appointment on ${formatSlot(a.starts_at)}`}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="contents">
                      <DoctorAvatar
                        doctorId={a.doctor_id}
                        name={a.doctor_name}
                        size={28}
                      />
                    </span>
                    {a.doctor_name}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={a.status} attendance={a.attendance} />
                </TableCell>
                <TableCell className="text-right">
                  <ChevronRightIcon
                    className="inline size-5 text-muted-foreground"
                    aria-hidden
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="space-y-3 md:hidden" data-testid="appointments-cards">
        {items.map((a) => (
          <li key={a.id}>
            <Link
              href={`/dashboard/appointments/${a.id}`}
              data-row-link
              data-row-label={rowLabel(a, view)}
              className={`flex min-h-16 items-center gap-3 rounded-xl border border-border bg-card/80 p-3 motion-safe:transition-[transform,background-color] motion-safe:active:scale-[0.985] hover:bg-card ${FOCUS}`}
            >
              <span aria-hidden="true" className="contents">
                <DoctorAvatar
                  doctorId={a.doctor_id}
                  name={a.doctor_name}
                  size={40}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {shownName(a.patient_name, view)}
                </span>
                <span className="block truncate text-sm text-muted-foreground">
                  {a.doctor_name}
                </span>
                <span className="block text-sm tabular-nums">
                  {formatSlot(a.starts_at)}
                </span>
              </span>
              <StatusBadge status={a.status} attendance={a.attendance} />
              <ChevronRightIcon
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>

      <nav
        aria-label="Pages"
        className="mt-4 flex items-center justify-between gap-3"
      >
        {firstHref ? (
          <Button asChild variant="outline" className="min-h-11">
            <Link href={firstHref}>Back to latest</Link>
          </Button>
        ) : (
          <span />
        )}
        {nextHref ? (
          <Button asChild className="min-h-11">
            <Link href={nextHref}>Older appointments</Link>
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">
            That is the end of the list.
          </span>
        )}
      </nav>
    </div>
  );
}

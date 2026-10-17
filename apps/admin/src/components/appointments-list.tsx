import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
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
import type { AdminAppointment } from "@clinic/api/generated";

// A table from md up, a stack of cards below it: a phone cannot hold five columns, and a card
// is one large tap target per appointment.
export function AppointmentsList({
  items,
  nextHref,
  firstHref,
}: {
  items: readonly AdminAppointment[];
  nextHref: string | null;
  firstHref: string | null;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
        No appointments match. Try another filter.
      </p>
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
              <TableHead className="text-right">
                <span className="sr-only">History</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="tabular-nums">
                  {formatSlot(a.starts_at)}
                </TableCell>
                <TableCell>{a.patient_name}</TableCell>
                <TableCell>{a.doctor_name}</TableCell>
                <TableCell>
                  <StatusBadge status={a.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm" className="min-h-9">
                    <Link
                      href={`/dashboard/appointments/${a.id}`}
                      aria-label={`History of ${a.patient_name}, ${formatSlot(a.starts_at)}`}
                    >
                      History
                    </Link>
                  </Button>
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
              className="flex min-h-16 items-center gap-3 rounded-xl border border-border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium tabular-nums">
                  {formatSlot(a.starts_at)}
                </span>
                <span className="block truncate">{a.patient_name}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  {a.doctor_name}
                </span>
              </span>
              <StatusBadge status={a.status} />
              <ChevronRightIcon
                className="size-5 text-muted-foreground"
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

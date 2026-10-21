import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";
import { auditList } from "@/lib/api";
import { AUDIT_ACTION } from "@/lib/audit-labels";
import { formatSlot } from "@/lib/clinic-time";
import { callerFor, requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Audit trail" };
export const dynamic = "force-dynamic";

// Every change staff made, newest first: who, what, why and whether the patient was told. Owner
// and admin only. The trail holds no patient names or contact details; the API never returns them.
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const staff = await requireStaff("manage-appointments");
  const q = await searchParams;
  const cursor = q.cursor && q.cursor.length < 400 ? q.cursor : null;
  const res = await auditList(callerFor(staff, staff.role), {
    limit: 25,
    cursor,
  });
  if (!res.ok) throw new Error(`audit failed (${res.status} ${res.code})`);
  const { items, next_cursor } = res.data;
  return (
    <div className="space-y-6 py-6">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Audit trail
      </h1>
      <p className="max-w-[60ch] text-muted-foreground">
        Every change staff made to an appointment, newest first. It cannot be
        edited.
      </p>
      {items.length === 0 ? (
        <p
          className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground"
          data-testid="audit-empty"
        >
          Nothing has been changed by staff yet. Actions on the dashboard appear
          here with their reason.
        </p>
      ) : (
        <ol
          className="divide-y divide-border rounded-xl border border-border bg-card/80"
          data-testid="audit-list"
        >
          {items.map((a) => (
            <li key={a.id} className="space-y-1 px-4 py-3">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">
                  {AUDIT_ACTION[a.action] ?? a.action}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {formatSlot(a.occurred_at)}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                By {a.actor_email} ({a.actor_role}).{" "}
                {a.notified ? "The patient was emailed." : "No patient email."}
              </p>
              <p className="text-sm">Reason: {a.reason}</p>
              {a.appointment_id && (
                <Link
                  href={`/dashboard/appointments/${a.appointment_id}`}
                  className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Open the appointment
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
      <nav aria-label="Pages" className="flex justify-between gap-3">
        {cursor ? (
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/audit">Back to the newest</Link>
          </Button>
        ) : (
          <span />
        )}
        {next_cursor && (
          <Button asChild className="min-h-11">
            <Link href={`/audit?cursor=${encodeURIComponent(next_cursor)}`}>
              Older entries
            </Link>
          </Button>
        )}
      </nav>
    </div>
  );
}

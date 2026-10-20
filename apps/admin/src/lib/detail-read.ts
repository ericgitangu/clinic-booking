import "server-only";

import type { AuditEntry, LineageEvent } from "@clinic/api/generated";
import { auditList, doctorNotice } from "@/lib/api";
import { loadAppointmentRow, loadLineage } from "@/lib/dashboard-data";
import { can } from "@/lib/roles";
import { authorise, callerFor } from "@/lib/session";

export interface DoctorNoticeView {
  id: string;
  status: "pending" | "sent" | "failed" | "skipped";
  reason:
    | "no_email"
    | "allowance_day"
    | "allowance_month"
    | "demo_address"
    | "not_configured"
    | null;
  attempts: number;
  sentAt: string | null;
  /** Whether sending again can help now (failed with tries left, or pending and nothing sending). */
  retryable: boolean;
}

export interface AppointmentDetail {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "booked" | "cancelled";
  doctorId: string;
  /** Names and attendance come from the admin list, which the API minimises by role. */
  doctorName: string | null;
  patientName: string | null;
  view: "full" | "minimised";
  attendance: "arrived" | "no_show" | null;
  locked: boolean;
  /** The reason on record for a cancellation; null when there is none or the role may not see it. */
  cancellationReason: string | null;
  events: LineageEvent[];
  /** What staff did to it and why. Owner and admin only: the API gives a viewer none of this. */
  audit: AuditEntry[] | null;
  /**
   * Whether the doctor was told of the arrival. Owner and admin only, and only for a visit marked
   * arrived; null otherwise.
   */
  doctorNotice: DoctorNoticeView | null;
  /** The server's clock, for "has it started", never the device's. */
  nowMs: number;
}

export type DetailResult =
  { ok: true; detail: AppointmentDetail } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Everything the appointment page shows, for the sheet that opens over a row. The same reads as the
// page, so a viewer gets exactly the viewer's view and no more: names and the reason on record are
// the API's own projection, and the audit trail (which holds reasons) is only asked for by roles
// that may read it.
export async function loadDetail(id: string): Promise<DetailResult> {
  const staff = await authorise("view");
  if (!staff)
    return { ok: false, message: "Your account is not allowed to do this." };
  if (!UUID.test(id))
    return { ok: false, message: "That appointment could not be found." };

  const [lineage, row] = await Promise.all([
    loadLineage(staff, id),
    loadAppointmentRow(staff, id),
  ]);
  if (!lineage.found || !row)
    return { ok: false, message: "That appointment could not be found." };
  const mayAudit = can(staff.role, "manage-appointments");
  const caller = callerFor(staff, staff.role);
  // Both reads need only the row, so they go out together.
  const [audit, notice] = await Promise.all([
    mayAudit ? auditList(caller, { appointment_id: id, limit: 25 }) : null,
    mayAudit && row.attendance === "arrived" ? doctorNotice(caller, id) : null,
  ]);
  return {
    ok: true,
    detail: {
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      doctorId: row.doctor_id,
      doctorName: row.doctor_name,
      patientName: row.patient_name,
      view: row.view,
      attendance: row.attendance ?? null,
      locked: row.staff_locked,
      // The admin row is minimised by role: a viewer gets no reason text.
      cancellationReason: row.cancellation_reason ?? null,
      events: lineage.events,
      audit: audit && audit.ok ? audit.data.items : null,
      doctorNotice:
        notice && notice.ok
          ? {
              id: notice.data.id,
              status: notice.data.status,
              reason: notice.data.reason,
              attempts: notice.data.attempts,
              sentAt: notice.data.sent_at,
              retryable: notice.data.retryable,
            }
          : null,
      nowMs: Date.now(),
    },
  };
}

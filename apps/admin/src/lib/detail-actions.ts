"use server";

import type { AuditEntry, LineageEvent } from "@clinic/api/generated";
import { auditList, getAppointment } from "@/lib/api";
import { loadAppointmentRow, loadLineage } from "@/lib/dashboard-data";
import { can } from "@/lib/roles";
import { authorise, callerFor } from "@/lib/session";

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

  const [lineage, current] = await Promise.all([
    loadLineage(staff, id),
    getAppointment(id),
  ]);
  if (!lineage.found || !current.ok)
    return { ok: false, message: "That appointment could not be found." };
  const appt = current.data;
  const mayAudit = can(staff.role, "manage-appointments");
  const [row, audit] = await Promise.all([
    loadAppointmentRow(staff, appt),
    mayAudit
      ? auditList(callerFor(staff, staff.role), {
          appointment_id: id,
          limit: 25,
        })
      : Promise.resolve(null),
  ]);
  return {
    ok: true,
    detail: {
      id: appt.id,
      startsAt: appt.starts_at,
      endsAt: appt.ends_at,
      status: appt.status,
      doctorId: appt.doctor_id,
      doctorName: row?.doctor_name ?? null,
      patientName: row?.patient_name ?? null,
      view: row?.view ?? "minimised",
      attendance: row?.attendance ?? null,
      locked: row?.staff_locked ?? false,
      // From the admin row (minimised by role), never the public read, which carries it in full.
      cancellationReason: row?.cancellation_reason ?? null,
      events: lineage.events,
      audit: audit && audit.ok ? audit.data.items : null,
      nowMs: Date.now(),
    },
  };
}

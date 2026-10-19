// The read that would let the dashboard list the visits behind the three figures the API gives only
// as counts: moves ("Reschedules"), cancellations by reason ("Why visits were cancelled") and the
// activity per day. It does not exist yet; this is the contract the dashboard is written against, so
// the backend can build exactly it. Until it answers, the sheets say so plainly and show the
// numbers they do have.
//
//   GET /internal/admin/ops/changes
//     ?kind=booked|rescheduled|cancelled      what happened (required)
//     &from=YYYY-MM-DD&to=YYYY-MM-DD          clinic-local days, [from, to), by the day it HAPPENED
//     &reason=<category>                      cancelled only: transport|illness|travel|work|weather|
//                                             felt_better|insurance|other (the same grouping as
//                                             /ops/cancellation-reasons)
//     &doctor_id=<uuid>                       optional
//     &limit=<1..100>&cursor=<opaque>         paging, as /appointments
//
//   200 ChangesPage
//     view: "full" | "minimised"              the viewer projection, chosen by the API from the role
//     kind, range: { from, to }
//     total: integer                          the count over the whole range, ignoring paging: the SAME
//                                             number the figure shows (see "agreement")
//     items: ChangeRow[]
//     next_cursor: string | null
//
//   ChangeRow
//     appointment_id, doctor_id, doctor_name
//     patient_name                            minimised for a viewer, as in the list
//     kind, occurred_at                       when the change was made (ISO, with offset)
//     actor: "patient" | "staff" | null
//     from_starts_at, to_starts_at            reschedules: where it was and where it went; else null
//     starts_at, status, attendance           the appointment as it is now
//     reason: string | null                   cancellation or staff reason; null for a viewer
//     reason_category: string | null          cancelled only
//
//   Agreement (what the e2e asserts): for the same [from, to),
//     total(kind=rescheduled)               == /ops/kpis reschedules.value
//     total(kind=cancelled)                 == /ops/cancellation-reasons total
//     total(kind=cancelled, reason=C)       == that category's count
//     total(kind=<k>, from=D, to=D+1)       == the /metrics series point for day D, kind k
//   Synthetic patients are left out, as everywhere else. 403 for no role; any role may read.
export type ChangeKind = "booked" | "rescheduled" | "cancelled";

export interface ChangeRow {
  appointment_id: string;
  doctor_id: string;
  doctor_name: string;
  patient_name: string;
  kind: ChangeKind;
  occurred_at: string;
  actor: "patient" | "staff" | null;
  from_starts_at: string | null;
  to_starts_at: string | null;
  starts_at: string;
  status: "booked" | "cancelled";
  attendance: "arrived" | "no_show" | null;
  reason: string | null;
  reason_category: string | null;
}

export interface ChangesPage {
  view: "full" | "minimised";
  kind: ChangeKind;
  range: { from: string; to: string };
  total: number;
  items: ChangeRow[];
  next_cursor: string | null;
}

export interface ChangesQuery {
  kind: ChangeKind;
  from: string;
  to: string;
  reason?: string;
}

export type ChangesResult =
  | {
      ok: true;
      view: "full" | "minimised";
      total: number;
      rows: ChangeRow[];
      truncated: boolean;
    }
  // The endpoint is not there yet: the sheet falls back to the figures and names the gap.
  | { ok: false; notBuilt: true }
  | { ok: false; notBuilt?: false; message: string };

// The live feed's events: parsing what the gateway sends, keeping the newest few, and describing
// one in a sentence. Pure functions, used by the panel and tested without a browser.
//
// What arrives depends on the role: owners and admins get the staff shape (patient name, the
// appointment to link to, a cancellation reason), viewers the minimised one (no person at all).
// Both are validated against the schemas generated from the API contract, and a viewer's message
// is refused outright if it carries any field of the staff shape.
import { zAdminEvent, zStaffEvent } from "@clinic/api/generated/zod.gen";
import type { Role } from "@/lib/roles";
import { formatSlot } from "@/lib/clinic-time";

export type LiveKind = "booked" | "rescheduled" | "cancelled";

export interface LiveEvent {
  /** "<txid>.<id>": the SSE id, the order key and the resume cursor. */
  seq: string;
  kind: LiveKind;
  doctorId: string;
  localDate: string;
  fromLocalDate: string | null;
  fromStartsAt: string | null;
  toStartsAt: string | null;
  /** Staff shape only. */
  appointmentId: string | null;
  patientName: string | null;
  cancellationReason: string | null;
}

const PERSONAL = ["appointment_id", "patient_name", "cancellation_reason"];

export function canSeePeople(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Returns null for anything that is not a valid event for this role (and says nothing else). */
export function parseLiveEvent(data: string, role: Role): LiveEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if (canSeePeople(role)) {
    const r = zStaffEvent.safeParse(raw);
    if (!r.success) return null;
    const d = r.data;
    return {
      seq: d.seq,
      kind: d.event_type,
      doctorId: d.doctor_id,
      localDate: d.local_date,
      fromLocalDate: d.from_local_date,
      fromStartsAt: d.from_starts_at,
      toStartsAt: d.to_starts_at,
      appointmentId: d.appointment_id,
      patientName: d.patient_name,
      cancellationReason: d.cancellation_reason,
    };
  }
  // A viewer's stream must never carry a person: refuse the whole message if it does.
  if (PERSONAL.some((k) => k in raw)) return null;
  const r = zAdminEvent.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  return {
    seq: d.seq,
    kind: d.event_type,
    doctorId: d.doctor_id,
    localDate: d.local_date,
    fromLocalDate: d.from_local_date,
    fromStartsAt: d.from_starts_at,
    toStartsAt: d.to_starts_at,
    appointmentId: null,
    patientName: null,
    cancellationReason: null,
  };
}

/** [txid, id] as BigInt, because txid is a 64-bit number a JS number cannot hold exactly. */
function key(seq: string): [bigint, bigint] {
  const [t, i] = seq.split(".");
  return [BigInt(t), BigInt(i)];
}

export function after(a: string, b: string): boolean {
  const [at, ai] = key(a);
  const [bt, bi] = key(b);
  return at > bt || (at === bt && ai > bi);
}

export const MAX_EVENTS = 30;

/** Newest first, no repeats, at most MAX_EVENTS. A repeat (a resume replays nothing, but the
 *  server may close and the browser may reconnect mid-batch) is dropped by its seq. */
export function addEvent(
  list: readonly LiveEvent[],
  ev: LiveEvent,
): LiveEvent[] {
  if (list.some((e) => e.seq === ev.seq)) return [...list];
  const next = [ev, ...list].sort((x, y) => (after(x.seq, y.seq) ? -1 : 1));
  return next.slice(0, MAX_EVENTS);
}

const VERB: Record<LiveKind, string> = {
  booked: "New booking",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};

export function verb(kind: LiveKind): string {
  return VERB[kind];
}

/** "Thu 22 Oct 10:00" for the time that matters: where the visit is now, or was. */
export function when(ev: LiveEvent): string {
  const at = ev.toStartsAt ?? ev.fromStartsAt;
  return at ? formatSlot(at) : ev.localDate;
}

/** For a screen reader and the list: who (if the role may know) and when. */
export function describe(
  ev: LiveEvent,
  doctorName: string | undefined,
  role: Role,
): string {
  const who = canSeePeople(role) && ev.patientName ? `${ev.patientName}, ` : "";
  const doc = doctorName ? ` with ${doctorName}` : "";
  const base = `${verb(ev.kind)}: ${who}${when(ev)}${doc}`;
  if (ev.kind === "rescheduled" && ev.fromStartsAt) {
    return `${base} (was ${formatSlot(ev.fromStartsAt)})`;
  }
  if (ev.kind === "cancelled" && canSeePeople(role) && ev.cancellationReason) {
    return `${base}. Reason: ${ev.cancellationReason}`;
  }
  return base;
}

// The live feed's events: parsing what the gateway sends, keeping the newest few, and describing
// one in a sentence. Pure functions, used by the panel and tested without a browser.
//
// Two families arrive on one stream. Appointment events (bookings, reschedules, cancellations and
// the staff annotations: veto, unlock, attendance) carry `event_type`; staff actions that change
// no appointment (a reminder sent now, "running late", invitations) carry `kind`. What arrives
// depends on the role: owners and admins get the staff shapes (patient name, the appointment to
// link to, reasons, who did it, the invited address), viewers the minimised ones (no person at
// all). Both are validated against the schemas generated from the API contract, and a viewer's
// message is refused outright if it carries any field of a staff shape.
import {
  zAdminActionEvent,
  zAdminEvent,
  zStaffActionEvent,
  zStaffEvent,
} from "@clinic/api/generated/zod.gen";
import type { Role } from "@/lib/roles";
import { formatSlot } from "@/lib/clinic-time";

export type AppointmentKind =
  | "booked"
  | "rescheduled"
  | "cancelled"
  | "vetoed"
  | "unlocked"
  | "arrived"
  | "no_show";
export type ActionKind =
  | "reminder_now"
  | "running_late"
  | "invite_created"
  | "invite_revoked"
  | "invite_accepted";
export type LiveKind = AppointmentKind | ActionKind;

export interface LiveEvent {
  /** "<txid>.<id>": the SSE id, the order key and the resume cursor. */
  seq: string;
  kind: LiveKind;
  doctorId: string | null;
  localDate: string | null;
  fromLocalDate: string | null;
  fromStartsAt: string | null;
  toStartsAt: string | null;
  /** Staff actions: the visit a reminder or "running late" is about, and the delay. */
  startsAt: string | null;
  delayMinutes: number | null;
  /** Staff shapes only. */
  appointmentId: string | null;
  patientName: string | null;
  cancellationReason: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  /** The reason the staff member recorded. */
  staffReason: string | null;
  inviteEmail: string | null;
  inviteRole: string | null;
}

/** Every field a staff shape adds. A viewer message carrying any of them is refused whole. */
const PERSONAL = [
  "appointment_id",
  "patient_name",
  "cancellation_reason",
  "actor_email",
  "actor_role",
  "staff_reason",
  "reason",
  "invite_email",
  "invite_role",
];

export function canSeePeople(role: Role): boolean {
  return role === "owner" || role === "admin";
}

const EMPTY = {
  doctorId: null,
  localDate: null,
  fromLocalDate: null,
  fromStartsAt: null,
  toStartsAt: null,
  startsAt: null,
  delayMinutes: null,
  appointmentId: null,
  patientName: null,
  cancellationReason: null,
  actorEmail: null,
  actorRole: null,
  staffReason: null,
  inviteEmail: null,
  inviteRole: null,
} satisfies Omit<LiveEvent, "seq" | "kind">;

function parseStaff(raw: object): LiveEvent | null {
  if ("kind" in raw) {
    const r = zStaffActionEvent.safeParse(raw);
    if (!r.success) return null;
    const d = r.data;
    return {
      ...EMPTY,
      seq: d.seq,
      kind: d.kind,
      doctorId: d.doctor_id,
      startsAt: d.starts_at,
      delayMinutes: d.delay_minutes,
      appointmentId: d.appointment_id,
      patientName: d.patient_name,
      actorEmail: d.actor_email,
      actorRole: d.actor_role,
      staffReason: d.reason,
      inviteEmail: d.invite_email,
      inviteRole: d.invite_role,
    };
  }
  const r = zStaffEvent.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  return {
    ...EMPTY,
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
    actorEmail: d.actor_email,
    actorRole: d.actor_role,
    staffReason: d.staff_reason,
  };
}

function parseViewer(raw: object): LiveEvent | null {
  // A viewer's stream must never carry a person: refuse the whole message if it does.
  if (PERSONAL.some((k) => k in raw)) return null;
  if ("kind" in raw) {
    const r = zAdminActionEvent.safeParse(raw);
    if (!r.success) return null;
    const d = r.data;
    return {
      ...EMPTY,
      seq: d.seq,
      kind: d.kind,
      doctorId: d.doctor_id,
      startsAt: d.starts_at,
      delayMinutes: d.delay_minutes,
    };
  }
  const r = zAdminEvent.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  return {
    ...EMPTY,
    seq: d.seq,
    kind: d.event_type,
    doctorId: d.doctor_id,
    localDate: d.local_date,
    fromLocalDate: d.from_local_date,
    fromStartsAt: d.from_starts_at,
    toStartsAt: d.to_starts_at,
  };
}

/** Returns null for anything that is not a valid event for this role (and says nothing else). */
export function parseLiveEvent(data: string, role: Role): LiveEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  return canSeePeople(role) ? parseStaff(raw) : parseViewer(raw);
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
  vetoed: "Vetoed",
  unlocked: "Unlocked",
  arrived: "Marked arrived",
  no_show: "Marked no-show",
  reminder_now: "Reminder sent",
  running_late: "Running late",
  invite_created: "Invite sent",
  invite_revoked: "Invite revoked",
  invite_accepted: "Invite accepted",
};

export function verb(kind: LiveKind): string {
  return VERB[kind];
}

/** "Thu 22 Oct 10:00" for the time that matters: where the visit is now, or was. */
export function when(ev: LiveEvent): string {
  const at = ev.toStartsAt ?? ev.fromStartsAt ?? ev.startsAt;
  return at ? formatSlot(at) : (ev.localDate ?? "");
}

const INVITES: readonly LiveKind[] = [
  "invite_created",
  "invite_revoked",
  "invite_accepted",
];

/** Whether the event is about one appointment (and so belongs on that appointment's page). */
export function isAboutAppointment(ev: LiveEvent): boolean {
  return !INVITES.includes(ev.kind);
}

function inviteLine(ev: LiveEvent, people: boolean): string {
  const role = ev.inviteRole ? ` (${ev.inviteRole})` : "";
  if (!people || !ev.inviteEmail) return verb(ev.kind);
  switch (ev.kind) {
    case "invite_created":
      return `Invite sent to ${ev.inviteEmail}${role}${ev.actorEmail ? ` by ${ev.actorEmail}` : ""}`;
    case "invite_revoked":
      return `Invite to ${ev.inviteEmail} revoked${ev.actorEmail ? ` by ${ev.actorEmail}` : ""}`;
    default:
      return `Invite accepted by ${ev.inviteEmail}${role}`;
  }
}

/**
 * For a screen reader and the list: what happened, who (if the role may know) and when. Owners
 * and admins read "Vetoed by <actor>: <reason>"; a viewer reads "Vetoed" and the time.
 */
export function describe(
  ev: LiveEvent,
  doctorName: string | undefined,
  role: Role,
): string {
  const people = canSeePeople(role);
  if (INVITES.includes(ev.kind)) return inviteLine(ev, people);

  const patient = people && ev.patientName ? `${ev.patientName}, ` : "";
  const doc = doctorName ? ` with ${doctorName}` : "";
  const by = people && ev.actorEmail ? ` by ${ev.actorEmail}` : "";
  const why = people && ev.staffReason ? `: ${ev.staffReason}` : "";

  switch (ev.kind) {
    case "vetoed":
    case "unlocked":
      // "Vetoed by admin@clinic: Doctor asked to keep the time. Wanjiru Kamau, Thu 22 Oct 10:00"
      return `${verb(ev.kind)}${by}${why}. ${patient}${when(ev)}${doc}`;
    case "arrived":
    case "no_show":
      return `${verb(ev.kind)}: ${patient}${when(ev)}${doc}${by}`;
    case "reminder_now":
      return `${verb(ev.kind)}: ${patient}${when(ev)}${doc}${by}`;
    case "running_late": {
      const delay = ev.delayMinutes ? ` (about ${ev.delayMinutes} min)` : "";
      return `${verb(ev.kind)}${delay}: ${patient}${when(ev)}${doc}${by}`;
    }
    default: {
      const base = `${verb(ev.kind)}${by}: ${patient}${when(ev)}${doc}`;
      if (ev.kind === "rescheduled" && ev.fromStartsAt) {
        return `${base} (was ${formatSlot(ev.fromStartsAt)})`;
      }
      if (ev.kind === "cancelled" && people && ev.cancellationReason) {
        return `${base}. Reason: ${ev.cancellationReason}`;
      }
      return base;
    }
  }
}

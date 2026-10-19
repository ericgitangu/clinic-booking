"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  checkRequest,
  type ApiFailure,
  type FieldIssue,
} from "@clinic/api/call";
import {
  zCancelRequest,
  zMeAppointmentCreate,
  zRescheduleRequest,
} from "@clinic/api/generated/zod.gen";
import type { ActionState, NextSlot } from "@/lib/action-state";
import * as api from "@/lib/api";
import { addDays, clinicDay, formatWhen } from "@/lib/clinic-time";
import { acknowledge } from "@/lib/email/acknowledge";
import { isForbidden, needsSignIn } from "@/lib/auth-failure";
import { heldMessage } from "@/lib/held";
import { checkHuman, type Action } from "@/lib/human-check";
import { describeProblem, fieldMessages } from "@/lib/problems";
import { patientName } from "@/lib/identity";
import { callerFor, getIdentity, type Identity } from "@/lib/session";

// Request bodies are checked with the schemas generated from the contract, never with rules
// written here: the form says what is wrong in plain words (lib/problems.ts), the contract says
// what is valid.

function blank(v: FormDataEntryValue | null): string | undefined {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? undefined : t;
}

function error(
  code: string,
  extra: Partial<Extract<ActionState, { status: "error" }>> = {},
): ActionState {
  const { message, severity } = describeProblem(code);
  return { status: "error", code, message, severity, ...extra };
}

function invalid(issues: FieldIssue[]): ActionState {
  return error("VALIDATION_ERROR", { fieldErrors: fieldMessages(issues) });
}

function failed(
  f: ApiFailure,
  extra: Partial<Extract<ActionState, { status: "error" }>> = {},
): ActionState {
  if (f.kind === "invalid_request") return invalid(f.issues);
  // The API refused the session: the person signs in again, whatever the action was.
  if (needsSignIn(f)) return error("UNAUTHENTICATED");
  // Signed in but not allowed: say so; signing in again would not help.
  if (isForbidden(f)) return error("FORBIDDEN");
  return error(f.code, extra);
}

const SIGN_IN_FIRST = error("UNAUTHENTICATED");

async function human(
  fd: FormData,
  action: Action,
): Promise<ActionState | null> {
  const r = await checkHuman(blank(fd.get("recaptcha_token")), action);
  if (r.ok) return null;
  return error(r.unavailable ? "INTERNAL_ERROR" : "NOT_HUMAN", {
    message: r.unavailable
      ? "We could not run the spam check. Try again in a moment."
      : "We could not tell that this came from a person. Reload the page and try again.",
    severity: r.unavailable ? "critical" : "error",
  });
}

// The next few free times for a doctor, looking at the given day and up to three after it.
async function nextFreeSlots(
  doctorId: string,
  fromIso: string,
): Promise<NextSlot[]> {
  const out: NextSlot[] = [];
  const first = clinicDay(fromIso);
  for (let i = 0; i < 4 && out.length < 6; i++) {
    const r = await api.getAvailability(doctorId, addDays(first, i));
    if (!r.ok) break;
    for (const s of r.data.slots) {
      if (s.starts_at !== fromIso) out.push({ starts_at: s.starts_at });
    }
  }
  return out.slice(0, 6);
}

// The key must be 1-255 visible ASCII characters, as the API requires. A key that is missing or
// malformed is replaced by a fresh one so the booking can still go ahead, but a fresh key is
// unique to this one call: it cannot dedupe a double submit. Only the key the form sent can.
const KEY_FORMAT = /^[\x21-\x7e]{1,255}$/;
function keyFor(sent: string | undefined): string {
  return sent !== undefined && KEY_FORMAT.test(sent)
    ? sent
    : crypto.randomUUID();
}

// The doctor's name and specialty for an email (a lookup that fails just leaves them out).
async function doctorFacts(doctorId: string) {
  const d = await api.getDoctor(doctorId);
  return d.ok
    ? { full_name: d.data.full_name, specialty: d.data.specialty }
    : null;
}

async function signedIn(): Promise<Identity | null> {
  return getIdentity();
}

export async function bookAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const who = await signedIn();
  if (!who) return SIGN_IN_FIRST;
  const doctorId = blank(fd.get("doctor_id"));
  const startsAt = blank(fd.get("starts_at"));
  const issues = checkRequest(zMeAppointmentCreate, {
    doctor_id: doctorId,
    starts_at: startsAt,
  });
  if (issues.length > 0) return invalid(issues);
  const doctor = doctorId as string;
  const when = startsAt as string;

  const blocked = await human(fd, "book");
  if (blocked) return blocked;

  const caller = callerFor(who);
  // Idempotent: makes the patient the first time this person books, finds it every time after.
  const linked = await api.linkAccount(caller, patientName(who));
  if (!linked.ok) return failed(linked);

  // Refuse a time the patient already holds before the API is asked: the API would also refuse it,
  // but only with a code; this says what happened and where to look. The API stays the final gate.
  const mine = await api.myAppointments(caller);
  if (mine.ok) {
    const live = mine.data.items.filter(
      (a) => a.status === "booked" && Date.parse(a.ends_at) > Date.now(),
    );
    const held = live.find((a) => Date.parse(a.starts_at) === Date.parse(when));
    if (held) {
      return {
        status: "error",
        code: "PATIENT_DOUBLE_BOOKED",
        severity: "warning",
        message: heldMessage({
          sameDoctor: held.doctor_id === doctor,
          when: formatWhen(when),
          doctor: held.doctor.full_name,
        }),
      };
    }
  }

  // The form makes one key per booking attempt and sends the same one with every submit of that
  // attempt, so two submits of one attempt (a double click, a retry after a lost response) reach
  // the API with the same key and the second is answered with the booking the first made.
  const booked = await api.bookMine(
    caller,
    { doctor_id: doctor, starts_at: when },
    keyFor(blank(fd.get("idempotency_key"))),
  );
  if (!booked.ok) {
    const taken = booked.kind === "problem" && booked.code === "SLOT_TAKEN";
    return failed(booked, {
      nextSlots: taken ? await nextFreeSlots(doctor, when) : undefined,
      doctorId: doctor,
    });
  }
  // After the response has gone, so the email can never hold up the confirmation page.
  const made = booked.data;
  after(async () =>
    acknowledge("booked", made, {
      caller,
      who,
      doctor: await doctorFacts(made.doctor_id),
    }),
  );
  redirect(`/book/confirmed/${booked.data.id}`);
}

export async function cancelAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const who = await signedIn();
  if (!who) return SIGN_IN_FIRST;
  const id = blank(fd.get("appointment_id")) ?? "";
  const reason = blank(fd.get("reason"));
  const issues = checkRequest(zCancelRequest, { reason });
  if (issues.length > 0) return invalid(issues);

  const blocked = await human(fd, "cancel");
  if (blocked) return blocked;

  const done = await api.cancelMine(callerFor(who), id, reason as string);
  if (!done.ok) {
    // An id that is not a UUID is refused by the contract before any call: it is simply not found.
    if (done.kind === "invalid_request") return error("APPOINTMENT_NOT_FOUND");
    return failed(done);
  }
  const cancelled = done.data;
  const asCaller = callerFor(who);
  after(async () =>
    acknowledge("cancelled", cancelled, {
      caller: asCaller,
      who,
      doctor: await doctorFacts(cancelled.doctor_id),
    }),
  );
  revalidatePath("/appointments");
  return { status: "done", message: "Appointment cancelled." };
}

export async function rescheduleAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const who = await signedIn();
  if (!who) return SIGN_IN_FIRST;
  const id = blank(fd.get("appointment_id")) ?? "";
  const startsAt = blank(fd.get("starts_at"));
  const issues = checkRequest(zRescheduleRequest, { starts_at: startsAt });
  if (issues.length > 0) return invalid(issues);

  const blocked = await human(fd, "reschedule");
  if (blocked) return blocked;

  const caller = callerFor(who);
  // The time it is moving from, for the email (a lookup that fails just leaves it out).
  const before = await api.myAppointment(caller, id);
  const done = await api.rescheduleMine(caller, id, startsAt as string);
  if (!done.ok) {
    if (done.kind === "invalid_request") return error("APPOINTMENT_NOT_FOUND");
    const taken = done.kind === "problem" && done.code === "SLOT_TAKEN";
    let doctorId: string | undefined;
    if (taken) {
      const own = await api.myAppointment(caller, id);
      doctorId = own.ok ? own.data.doctor_id : undefined;
    }
    return failed(done, {
      nextSlots:
        taken && doctorId
          ? await nextFreeSlots(doctorId, startsAt as string)
          : undefined,
      doctorId,
    });
  }
  const moved = done.data;
  const previousStartsAt = before.ok ? before.data.starts_at : undefined;
  after(async () =>
    acknowledge("rescheduled", moved, {
      caller,
      who,
      doctor: await doctorFacts(moved.doctor_id),
      previousStartsAt,
    }),
  );
  revalidatePath("/appointments");
  redirect("/appointments?rescheduled=1");
}

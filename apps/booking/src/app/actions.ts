"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
import { addDays, clinicDay } from "@/lib/clinic-time";
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

// 1-255 visible ASCII characters, as the API requires; anything else is replaced, never forwarded.
function attemptKey(sent: string | undefined): string {
  return sent !== undefined && /^[\x21-\x7e]{1,255}$/.test(sent)
    ? sent
    : crypto.randomUUID();
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

  // The form makes one key per booking attempt and sends it again with a retry of that attempt.
  // A request that arrives without a usable one still gets a fresh key, so a double submit that
  // overlaps is collapsed by the API either way.
  const booked = await api.bookMine(
    caller,
    { doctor_id: doctor, starts_at: when },
    attemptKey(blank(fd.get("idempotency_key"))),
  );
  if (!booked.ok) {
    const taken = booked.kind === "problem" && booked.code === "SLOT_TAKEN";
    return failed(booked, {
      nextSlots: taken ? await nextFreeSlots(doctor, when) : undefined,
      doctorId: doctor,
    });
  }
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
  revalidatePath("/appointments");
  redirect("/appointments?rescheduled=1");
}

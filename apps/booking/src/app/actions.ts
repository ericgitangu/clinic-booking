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
  zPostPatientPatientsPostBody,
  zRescheduleRequest,
  zAppointmentCreate,
} from "@clinic/api/generated/zod.gen";
import { logError } from "@clinic/api/proxy/log";
import type { ActionState, NextSlot } from "@/lib/action-state";
import * as api from "@/lib/api";
import { addDays, clinicDay } from "@/lib/clinic-time";
import { checkHuman, type Action } from "@/lib/human-check";
import {
  cookieConfigured,
  forgetPatient,
  readPatient,
  rememberPatient,
} from "@/lib/patient-cookie";
import { describeProblem, fieldMessages } from "@/lib/problems";

// Request bodies are checked with the schemas generated from the contract, never with rules
// written here: the form says what is wrong in plain words (lib/problems.ts), the contract says
// what is valid.
const appointmentWhen = zAppointmentCreate.pick({
  doctor_id: true,
  starts_at: true,
});

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

// A failed API call as a screen state. A request the contract refused becomes field errors; a
// contract violation or an unreachable API becomes the generic critical message.
function failed(
  f: ApiFailure,
  extra: Partial<Extract<ActionState, { status: "error" }>> = {},
): ActionState {
  if (f.kind === "invalid_request") return invalid(f.issues);
  return error(f.code, extra);
}

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

export async function bookAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  if (!cookieConfigured()) {
    // Without the signing secret nothing could be remembered, so refuse before creating anything.
    logError("booking refused: CLINIC_COOKIE_SECRET is not set", {});
    return error("INTERNAL_ERROR");
  }
  const remembered =
    fd.get("as_remembered") === "1" ? await readPatient() : null;
  const doctorId = blank(fd.get("doctor_id"));
  const startsAt = blank(fd.get("starts_at"));

  // Check everything the booking needs before creating anything, so a bad time never leaves a
  // patient behind.
  const patientBody = remembered
    ? null
    : {
        full_name: blank(fd.get("full_name")),
        phone: blank(fd.get("phone")) ?? null,
        email: blank(fd.get("email")) ?? null,
      };
  const issues = [
    ...(patientBody
      ? checkRequest(zPostPatientPatientsPostBody, patientBody)
      : []),
    ...checkRequest(appointmentWhen, {
      doctor_id: doctorId,
      starts_at: startsAt,
    }),
  ];
  if (issues.length > 0) return invalid(issues);
  // Narrowed by the checks above.
  const doctor = doctorId as string;
  const when = startsAt as string;

  const blocked = await human(fd, "book");
  if (blocked) return blocked;

  let patientId = remembered?.id;
  if (!patientId) {
    const created = await api.createPatient(
      patientBody as {
        full_name: string;
        phone: string | null;
        email: string | null;
      },
    );
    if (!created.ok) return failed(created);
    patientId = created.data.id;
    // Remember at once: if the slot turns out to be taken, the retry reuses this patient.
    await rememberPatient({ id: patientId, name: created.data.full_name });
  }

  const booked = await api.createAppointment({
    doctor_id: doctor,
    patient_id: patientId,
    starts_at: when,
  });
  if (!booked.ok) {
    const taken =
      !booked.ok && booked.kind === "problem" && booked.code === "SLOT_TAKEN";
    return failed(booked, {
      nextSlots: taken ? await nextFreeSlots(doctor, when) : undefined,
      doctorId: doctor,
    });
  }
  redirect(`/book/confirmed/${booked.data.id}`);
}

// A visitor may only change appointments that belong to the patient this browser remembers.
async function owned(
  id: string,
): Promise<{ ok: true; doctorId: string } | { ok: false; state: ActionState }> {
  const patient = await readPatient();
  if (!patient) return { ok: false, state: error("APPOINTMENT_NOT_FOUND") };
  const found = await api.getAppointment(id);
  // An id that is not a UUID is refused by the contract before any call: it is simply not found.
  if (!found.ok) {
    return {
      ok: false,
      state:
        found.kind === "invalid_request"
          ? error("APPOINTMENT_NOT_FOUND")
          : failed(found),
    };
  }
  if (found.data.patient_id !== patient.id) {
    return { ok: false, state: error("APPOINTMENT_NOT_FOUND") };
  }
  return { ok: true, doctorId: found.data.doctor_id };
}

export async function cancelAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const id = blank(fd.get("appointment_id")) ?? "";
  const reason = blank(fd.get("reason"));
  const issues = checkRequest(zCancelRequest, { reason });
  if (issues.length > 0) return invalid(issues);

  const blocked = await human(fd, "cancel");
  if (blocked) return blocked;
  const own = await owned(id);
  if (!own.ok) return own.state;

  const done = await api.cancelAppointment(id, reason as string);
  if (!done.ok) return failed(done);
  revalidatePath("/appointments");
  return { status: "done", message: "Appointment cancelled." };
}

export async function rescheduleAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const id = blank(fd.get("appointment_id")) ?? "";
  const startsAt = blank(fd.get("starts_at"));
  const issues = checkRequest(zRescheduleRequest, { starts_at: startsAt });
  if (issues.length > 0) return invalid(issues);

  const blocked = await human(fd, "reschedule");
  if (blocked) return blocked;
  const own = await owned(id);
  if (!own.ok) return own.state;

  const done = await api.rescheduleAppointment(id, startsAt as string);
  if (!done.ok) {
    const taken = done.kind === "problem" && done.code === "SLOT_TAKEN";
    return failed(done, {
      nextSlots: taken
        ? await nextFreeSlots(own.doctorId, startsAt as string)
        : undefined,
      doctorId: own.doctorId,
    });
  }
  revalidatePath("/appointments");
  redirect("/appointments?rescheduled=1");
}

export async function clearRememberedPatient(): Promise<void> {
  await forgetPatient();
  revalidatePath("/appointments");
  redirect("/book");
}

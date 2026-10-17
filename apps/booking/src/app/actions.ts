"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import * as api from "@/lib/api";
import { addDays, clinicDay } from "@/lib/clinic-time";
import { checkHuman, type Action } from "@/lib/human-check";
import { logError } from "@clinic/api/proxy/log";
import {
  cookieConfigured,
  forgetPatient,
  readPatient,
  rememberPatient,
} from "@/lib/patient-cookie";
import type { ActionState, NextSlot } from "@/lib/action-state";
import { describeProblem } from "@/lib/problems";

const uuid = z.string().uuid();
// The API refuses a time without an offset; the picker always sends one.
const isoWithOffset = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

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

const BookSchema = z.object({
  doctor_id: uuid,
  starts_at: isoWithOffset,
  full_name: z.string().min(2, "Enter your full name.").max(200),
  phone: z
    .string()
    .regex(
      /^\+[1-9][0-9]{7,14}$/,
      "Use international format, like +254712345678.",
    )
    .optional(),
  email: z.string().email("Enter a valid email address.").optional(),
});

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
  const parsed = BookSchema.safeParse({
    doctor_id: blank(fd.get("doctor_id")),
    starts_at: blank(fd.get("starts_at")),
    full_name: remembered?.name ?? blank(fd.get("full_name")),
    phone: remembered ? undefined : blank(fd.get("phone")),
    email: remembered ? undefined : blank(fd.get("email")),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return error("VALIDATION_ERROR", { fieldErrors });
  }
  const input = parsed.data;

  const blocked = await human(fd, "book");
  if (blocked) return blocked;

  let patientId = remembered?.id;
  if (!patientId) {
    const created = await api.createPatient({
      full_name: input.full_name,
      phone: input.phone ?? null,
      email: input.email ?? null,
    });
    if (!created.ok) {
      return error(created.code);
    }
    patientId = created.data.id;
    // Remember at once: if the slot turns out to be taken, the retry reuses this patient.
    await rememberPatient({ id: patientId, name: created.data.full_name });
  }

  const booked = await api.createAppointment({
    doctor_id: input.doctor_id,
    patient_id: patientId,
    starts_at: input.starts_at,
  });
  if (!booked.ok) {
    const nextSlots =
      booked.code === "SLOT_TAKEN"
        ? await nextFreeSlots(input.doctor_id, input.starts_at)
        : undefined;
    return error(booked.code, { nextSlots, doctorId: input.doctor_id });
  }
  redirect(`/book/confirmed/${booked.data.id}`);
}

// A visitor may only change appointments that belong to the patient this browser remembers.
async function owned(
  id: string,
): Promise<
  | { ok: true; doctorId: string; startsAt: string }
  | { ok: false; state: ActionState }
> {
  const patient = await readPatient();
  if (!uuid.safeParse(id).success || !patient) {
    return { ok: false, state: error("APPOINTMENT_NOT_FOUND") };
  }
  const found = await api.getAppointment(id);
  if (!found.ok)
    return {
      ok: false,
      state: error(found.code === "UNKNOWN" ? "INTERNAL_ERROR" : found.code),
    };
  if (found.data.patient_id !== patient.id)
    return { ok: false, state: error("APPOINTMENT_NOT_FOUND") };
  return {
    ok: true,
    doctorId: found.data.doctor_id,
    startsAt: found.data.starts_at,
  };
}

export async function cancelAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const id = blank(fd.get("appointment_id")) ?? "";
  const reason = z
    .string()
    .min(3, "Say briefly why (at least 3 characters).")
    .max(500);
  const r = reason.safeParse(blank(fd.get("reason")) ?? "");
  if (!r.success)
    return error("VALIDATION_ERROR", {
      fieldErrors: { reason: r.error.issues[0].message },
    });

  const blocked = await human(fd, "cancel");
  if (blocked) return blocked;
  const own = await owned(id);
  if (!own.ok) return own.state;

  const done = await api.cancelAppointment(id, r.data);
  if (!done.ok) return error(done.code);
  revalidatePath("/appointments");
  return { status: "done", message: "Appointment cancelled." };
}

export async function rescheduleAppointment(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const id = blank(fd.get("appointment_id")) ?? "";
  const when = isoWithOffset.safeParse(blank(fd.get("starts_at")) ?? "");
  if (!when.success)
    return error("VALIDATION_ERROR", {
      fieldErrors: { starts_at: "Pick a time." },
    });

  const blocked = await human(fd, "reschedule");
  if (blocked) return blocked;
  const own = await owned(id);
  if (!own.ok) return own.state;

  const done = await api.rescheduleAppointment(id, when.data);
  if (!done.ok) {
    const nextSlots =
      done.code === "SLOT_TAKEN"
        ? await nextFreeSlots(own.doctorId, when.data)
        : undefined;
    return error(done.code, { nextSlots, doctorId: own.doctorId });
  }
  revalidatePath("/appointments");
  redirect("/appointments?rescheduled=1");
}

export async function clearRememberedPatient(): Promise<void> {
  await forgetPatient();
  revalidatePath("/appointments");
  redirect("/book");
}

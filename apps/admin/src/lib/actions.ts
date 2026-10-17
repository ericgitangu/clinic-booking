"use server";

import { revalidatePath } from "next/cache";
import type { ApiFailure } from "@clinic/api/call";
import {
  availability,
  cancelForPatient,
  changeAccessRole as changeRole,
  grantAccess as grant,
  rescheduleForPatient,
  revokeAccess as revoke,
} from "@/lib/api";
import { authorise, callerFor } from "@/lib/session";

export type ActionResult =
  { ok: true; message: string } | { ok: false; message: string };

const DENIED: ActionResult = {
  ok: false,
  message: "Your account is not allowed to do this.",
};

const COPY: Record<string, string> = {
  ACCESS_EXISTS: "That email already has access. Change its role instead.",
  ACCESS_NOT_FOUND: "That email has no active access.",
  OWNER_PROTECTED: "The owner's access is fixed and cannot be changed.",
  APPOINTMENT_ALREADY_CANCELLED: "This appointment is already cancelled.",
  APPOINTMENT_ALREADY_STARTED: "This appointment has already started.",
  SLOT_TAKEN: "That time was just taken. Pick another.",
  SLOT_IN_PAST: "That time has passed. Pick a later one.",
  BOOKING_TOO_SOON: "That time is too soon to book. Pick a later one.",
  OUTSIDE_WORKING_HOURS: "The doctor does not work at that time.",
  PATIENT_DOUBLE_BOOKED: "The patient already has an appointment then.",
  FORBIDDEN: "Your account is not allowed to do this.",
};

// `invalid` is what to say when the generated request schema refused the input, before anything
// was sent.
function describe(f: ApiFailure, invalid: string): ActionResult {
  if (f.kind === "invalid_request") return { ok: false, message: invalid };
  const known = COPY[f.code];
  if (known) return { ok: false, message: known };
  if (f.status >= 500)
    return {
      ok: false,
      message: "The clinic service is not answering. Try again in a moment.",
    };
  return { ok: false, message: "That did not work. Try again." };
}

const normalise = (email: string) => email.trim().toLowerCase();

function grantable(role: string): role is "admin" | "viewer" {
  return role === "admin" || role === "viewer";
}

// What is checked here is the role of the person asking. Every argument is then checked against
// the generated request schema by the SDK, so a bad email, role, id or date never leaves the
// server.
export async function grantAccess(
  email: string,
  role: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-access");
  if (!staff) return DENIED;
  const address = normalise(email);
  if (!grantable(role))
    return { ok: false, message: "Enter a valid email address and a role." };
  const res = await grant(callerFor(staff, staff.role), address, role);
  if (!res.ok) return describe(res, "Enter a valid email address and a role.");
  revalidatePath("/access");
  return { ok: true, message: `Access granted to ${address}.` };
}

export async function changeAccessRole(
  email: string,
  role: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-access");
  if (!staff) return DENIED;
  const address = normalise(email);
  if (!grantable(role)) return { ok: false, message: "Pick a role." };
  const res = await changeRole(callerFor(staff, staff.role), address, role);
  if (!res.ok) return describe(res, "Pick a role.");
  revalidatePath("/access");
  return { ok: true, message: `${address} is now ${role}.` };
}

export async function revokeAccess(email: string): Promise<ActionResult> {
  const staff = await authorise("manage-access");
  if (!staff) return DENIED;
  const address = normalise(email);
  const res = await revoke(callerFor(staff, staff.role), address);
  if (!res.ok) return describe(res, "That is not a valid email address.");
  revalidatePath("/access");
  return { ok: true, message: `Access revoked for ${address}.` };
}

// Acting for a patient goes through the API's admin endpoints, which apply the same booking rules
// as the public ones and refuse a caller whose role is not owner or admin.
export async function cancelAppointment(
  id: string,
  reason: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const text = reason.trim();
  if (text.length < 3 || text.length > 450)
    return { ok: false, message: "Give a reason of at least 3 characters." };
  const res = await cancelForPatient(
    callerFor(staff, staff.role),
    id,
    `${text} (cancelled by clinic staff)`,
  );
  if (!res.ok) return describe(res, "Give a reason of at least 3 characters.");
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Appointment cancelled." };
}

export async function rescheduleAppointment(
  id: string,
  startsAt: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const res = await rescheduleForPatient(
    callerFor(staff, staff.role),
    id,
    startsAt,
  );
  if (!res.ok) return describe(res, "Pick a time.");
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Appointment rescheduled." };
}

export type SlotsResult =
  { ok: true; slots: { startsAt: string }[] } | { ok: false; message: string };

export async function loadSlots(
  doctorId: string,
  date: string,
): Promise<SlotsResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return { ok: false, message: DENIED.message };
  const res = await availability(doctorId, date);
  if (!res.ok)
    return { ok: false, message: describe(res, "Pick a date.").message };
  return {
    ok: true,
    slots: res.data.slots.map((s) => ({ startsAt: s.starts_at })),
  };
}

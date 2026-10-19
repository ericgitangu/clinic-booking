"use server";

import { revalidatePath, updateTag } from "next/cache";
import type { ApiFailure } from "@clinic/api/call";
import {
  availability,
  cancelForPatient,
  changeAccessRole as changeRole,
  grantAccess as grant,
  inviteAccept,
  inviteCreate,
  inviteRevoke,
  markAttendance as mark,
  unlockAppointment as unlock,
  vetoAppointment as veto,
  rescheduleForPatient,
  staffBook,
  revokeAccess as revoke,
} from "@/lib/api";
import { SITE } from "@/lib/site";
import { METRICS_TAG } from "@/lib/metrics-cache";
import { authorise, callerFor, getStaff } from "@/lib/session";

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
  CHANGE_TOO_LATE:
    "This visit starts in less than an hour, so a patient cannot change it. Staff can; try again.",
  APPOINTMENT_LOCKED: "This appointment is locked by staff.",
  NOTHING_TO_VETO:
    "The patient has not changed this appointment, so there is nothing to undo.",
  ROLE_ESCALATION: "Only the owner can change an admin's access.",
  INVITE_INVALID: "That invitation is not valid.",
  RATE_LIMITED: "Too many invitations today. Try again tomorrow.",
  APPOINTMENT_NOT_FOUND: "That appointment could not be found.",
  ATTENDANCE_WINDOW_CLOSED:
    "Arrival can be marked from 15 minutes before the visit until 2 hours after it starts.",
  PATIENT_PHONE_EXISTS: "A patient with that phone number already exists.",
  UNKNOWN_DOCTOR: "That doctor is not available.",
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

function validReason(reason: string): string | null {
  const text = reason.trim();
  return text.length >= 3 && text.length <= 450 ? text : null;
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
  updateTag(METRICS_TAG);
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
  updateTag(METRICS_TAG);
  revalidatePath("/access");
  return { ok: true, message: `${address} is now ${role}.` };
}

export async function revokeAccess(email: string): Promise<ActionResult> {
  // An admin may revoke a viewer; the API answers ROLE_ESCALATION for anyone else, so owner and
  // admin both pass this check and the API decides.
  const staff = await authorise("manage-access");
  if (!staff) return DENIED;
  const address = normalise(email);
  const res = await revoke(callerFor(staff, staff.role), address);
  if (!res.ok) return describe(res, "That is not a valid email address.");
  updateTag(METRICS_TAG);
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
  const res = await cancelForPatient(callerFor(staff, staff.role), id, text);
  if (!res.ok) return describe(res, "Give a reason of at least 3 characters.");
  updateTag(METRICS_TAG);
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Appointment cancelled." };
}

export async function rescheduleAppointment(
  id: string,
  startsAt: string,
  reason: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const text = reason.trim();
  if (text.length < 3 || text.length > 450)
    return { ok: false, message: "Give a reason of at least 3 characters." };
  const res = await rescheduleForPatient(
    callerFor(staff, staff.role),
    id,
    startsAt,
    text,
  );
  if (!res.ok) return describe(res, "Pick a time.");
  updateTag(METRICS_TAG);
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Appointment rescheduled." };
}

// Arrived or no-show, from 15 minutes before the visit to 2 hours after it starts. Marking what is
// already marked changes nothing; changing an earlier mark needs a reason (the API says so).
export async function markAttendance(
  id: string,
  kind: "arrived" | "no_show",
  reason?: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const text = reason?.trim();
  const res = await mark(
    callerFor(staff, staff.role),
    id,
    kind,
    text ? text : undefined,
  );
  if (!res.ok) return describe(res, "Give a reason of at least 3 characters.");
  updateTag(METRICS_TAG);
  revalidatePath("/dashboard", "layout");
  return {
    ok: true,
    message: kind === "arrived" ? "Marked as arrived." : "Marked as no-show.",
  };
}

// Book a free slot for a patient who called or walked in. Staff are not held to the lead-time rule;
// the API still refuses a taken slot, a time that has passed and a patient already booked then.
export async function bookOnBehalf(input: {
  doctorId: string;
  startsAt: string;
  reason: string;
  fullName: string;
  phone: string;
  email: string;
}): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const reason = input.reason.trim();
  const fullName = input.fullName.trim();
  if (reason.length < 3 || fullName.length < 2)
    return {
      ok: false,
      message: "Give the patient's name and a reason of at least 3 characters.",
    };
  const phone = input.phone.trim();
  const email = input.email.trim();
  const res = await staffBook(callerFor(staff, staff.role), {
    doctor_id: input.doctorId,
    starts_at: input.startsAt,
    reason,
    patient: {
      full_name: fullName,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
    },
  });
  if (!res.ok)
    return describe(res, "Check the name, phone number and email address.");
  updateTag(METRICS_TAG);
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: `Booked for ${res.data.patient_name}.` };
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

// The dashboard's refresh button: expires the cached metrics so the next render asks the API.
// Any role that may view the dashboard may refresh it; nothing is written.
export async function refreshMetrics(): Promise<ActionResult> {
  const staff = await authorise("view");
  if (!staff) return DENIED;
  updateTag(METRICS_TAG);
  revalidatePath("/dashboard");
  return { ok: true, message: "Dashboard refreshed." };
}

// Veto: undo the patient's most recent change and lock the appointment, so the patient can no
// longer book, cancel or move it until staff unlock it. A reason is required and is kept in the
// audit trail and sent to the patient.
export async function vetoAppointment(
  id: string,
  reason: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const text = validReason(reason);
  if (!text)
    return { ok: false, message: "Give a reason of at least 3 characters." };
  const res = await veto(callerFor(staff, staff.role), id, text);
  if (!res.ok) return describe(res, "Give a reason of at least 3 characters.");
  updateTag(METRICS_TAG);
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Change undone and the appointment locked." };
}

export async function unlockAppointment(
  id: string,
  reason: string,
): Promise<ActionResult> {
  const staff = await authorise("manage-appointments");
  if (!staff) return DENIED;
  const text = validReason(reason);
  if (!text)
    return { ok: false, message: "Give a reason of at least 3 characters." };
  const res = await unlock(callerFor(staff, staff.role), id, text);
  if (!res.ok) return describe(res, "Give a reason of at least 3 characters.");
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Appointment unlocked." };
}

// Invites. The raw token exists only in the response to creating one. It is shown once here as a
// link the inviter copies and sends; this app does not store it.
export type InviteResult =
  { ok: true; message: string; link: string } | { ok: false; message: string };

export async function createInvite(
  email: string,
  role: string,
): Promise<InviteResult> {
  const staff = await authorise("manage-access");
  if (!staff) return { ok: false, message: DENIED.message };
  if (!grantable(role)) return { ok: false, message: "Pick admin or viewer." };
  const address = normalise(email);
  const res = await inviteCreate(callerFor(staff, staff.role), address, role);
  if (!res.ok)
    return {
      ok: false,
      message: describe(res, "That is not a valid email address.").message,
    };
  const inv = res.data;
  revalidatePath("/access");
  return {
    ok: true,
    message: `Invitation made for ${inv.email}.`,
    link: `${SITE.url}/invite/${encodeURIComponent(inv.token)}`,
  };
}

export async function revokeInvite(id: string): Promise<ActionResult> {
  const staff = await authorise("manage-access");
  if (!staff) return DENIED;
  const res = await inviteRevoke(callerFor(staff, staff.role), id);
  if (!res.ok) return describe(res, "That invitation could not be found.");
  revalidatePath("/access");
  return { ok: true, message: "Invitation revoked." };
}

// Accepting an invitation needs a signed-in Google account, not a role: the person has none yet.
// The API compares the account's verified email with the invitation's, and every failure (wrong
// email, expired, used, revoked, unknown) is the same 404, so the message here is the same too.
export async function acceptInvite(token: string): Promise<ActionResult> {
  const who = await getStaff();
  if (!who) return { ok: false, message: "Sign in with Google first." };
  if (token.length < 8 || token.length > 200)
    return {
      ok: false,
      message: "That invitation is not valid for this account.",
    };
  const res = await inviteAccept(callerFor(who, "none"), token);
  if (!res.ok) {
    return res.status === 429
      ? { ok: false, message: "Too many tries. Wait a little and try again." }
      : {
          ok: false,
          message: "That invitation is not valid for this account.",
        };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `You now have access as ${res.data.role}.` };
}

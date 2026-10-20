// The seven staff emails. Each returns { subject, html, text } and nothing else: no I/O, no clock, no
// request. Sending lives in send.ts.
//
// Look and wording follow the patient app's branded emails (ink navy text, lotus-blue button, mist
// behind a white card, plain Kenyan English, East Africa Time). They are written as plain strings
// with inline styles, as mail clients need, rather than through React, so the admin app takes on no
// rendering dependency. Everything that comes from a person (names, the reason) goes through
// `escapeHtml` on the way into the HTML and is left as written in the text version.
import { APPOINTMENT_MINUTES } from "@clinic/api/appointment";
import type { Composed } from "@clinic/api/mail";
import { SITE } from "@/lib/site";
import { formatWhen, zoneLabel } from "@/emails/time";

export type { Composed };

/** Facts about one appointment. Times are ISO strings from the API; `timezone` is the clinic's IANA zone. */
export interface AppointmentFacts {
  /** The patient's name as the API returned it (`patient_name`). */
  name: string;
  /** `doctor_name`. */
  doctor: string;
  /** `starts_at`. */
  startsAt: string;
  /** The appointment's own `timezone`; East Africa Time when left out. */
  timezone?: string;
}

/** The reason staff gave, shown to the patient. Required: every staff write has one (3 to 500 characters). */
export interface WithReason {
  reason: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A header value must stay on one line: anything that could break the subject is folded to a space.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

const INK = "#14204f";
const LOTUS = "#243a8c";
const MIST = "#f4f8fc";
const AQUA = "#e3eef9";
const MUTED = "#4a5878";

interface BoxLine {
  text: string;
  strong?: boolean;
  muted?: boolean;
  /** The old time, drawn crossed out. */
  strike?: boolean;
  /** Said before the text, e.g. "Was". */
  label?: string;
}

interface Card {
  preview: string;
  heading: string;
  lead: string;
  /** Lines in the blue box, in order; `strike` draws the old time crossed out. */
  box: BoxLine[];
  reason?: string;
  reasonLabel?: string;
  extra?: string[];
  button: { label: string; href: string };
  /** Why the reader is getting it, for the foot of the email. */
  why: string;
}

const NAME = "Idyllic Clinic";

function html(c: Card): string {
  const p = (style: string, body: string) => `<p style="${style}">${body}</p>`;
  const box = c.box
    .map((l) =>
      p(
        `margin:4px 0 0;font-size:${l.strong ? 18 : l.muted ? 13 : 15}px;${l.strong ? "font-weight:700;" : ""}${l.muted || l.strike ? `color:${MUTED};` : ""}${l.strike ? "text-decoration:line-through;" : ""}`,
        escapeHtml(l.label ? `${l.label}: ${l.text}` : l.text),
      ),
    )
    .join("");
  const extra = (c.extra ?? [])
    .map((t) =>
      p(`margin:14px 0 0;font-size:15px;line-height:22px;`, escapeHtml(t)),
    )
    .join("");
  const reason = c.reason
    ? p(
        `margin:16px 0 0;font-size:14px;color:${MUTED};`,
        `${escapeHtml(c.reasonLabel ?? "Reason")}: ${escapeHtml(c.reason)}`,
      )
    : "";
  const privacy = `${SITE.bookingUrl}/privacy`;
  return [
    `<!DOCTYPE html>`,
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.heading)}</title></head>`,
    `<body style="background-color:${MIST};margin:0;padding:24px 12px;font-family:Helvetica,Arial,sans-serif;color:${INK};">`,
    `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(c.preview)}</div>`,
    `<div style="max-width:520px;margin:0 auto;">`,
    `<div style="padding:0 0 16px;"><img src="${SITE.url}/brand/idyllic-mark.png" width="44" height="44" alt="Idyllic">`,
    p(`margin:8px 0 0;font-size:14px;color:${MUTED};`, NAME),
    `</div>`,
    `<div style="background-color:#ffffff;border-radius:12px;padding:28px 24px;border:1px solid ${AQUA};">`,
    `<h1 style="margin:0 0 12px;font-size:24px;line-height:30px;color:${INK};">${escapeHtml(c.heading)}</h1>`,
    p(`margin:0 0 20px;font-size:16px;line-height:24px;`, escapeHtml(c.lead)),
    box
      ? `<div style="background-color:${AQUA};border-radius:8px;padding:14px 16px;">${box}</div>`
      : "",
    reason,
    extra,
    `<div style="padding:24px 0 4px;"><a href="${escapeHtml(c.button.href)}" style="background-color:${LOTUS};color:#ffffff;border-radius:8px;padding:12px 20px;font-size:16px;font-weight:700;text-decoration:none;display:inline-block;">${escapeHtml(c.button.label)}</a></div>`,
    `</div>`,
    `<hr style="border:0;border-top:1px solid ${AQUA};margin:24px 0 12px;">`,
    p(
      `margin:0;font-size:12px;line-height:18px;color:${MUTED};`,
      `${escapeHtml(c.why)} Replies go to the engineer who built it. See <a href="${privacy}" style="color:${LOTUS};">how your data is handled</a>.`,
    ),
    `</div></body></html>`,
  ].join("\n");
}

function text(c: Card): string {
  const lines = [c.heading.toUpperCase(), "", c.lead, ""];
  for (const l of c.box) lines.push(l.label ? `${l.label}: ${l.text}` : l.text);
  if (c.reason) lines.push("", `${c.reasonLabel ?? "Reason"}: ${c.reason}`);
  for (const t of c.extra ?? []) lines.push("", t);
  lines.push("", `${c.button.label}: ${c.button.href}`);
  lines.push(
    "",
    "--",
    `${c.why} Replies go to the engineer who built it.`,
    `How your data is handled: ${SITE.bookingUrl}/privacy`,
  );
  return lines.join("\n");
}

const compose = (subject: string, c: Card): Composed => ({
  subject: oneLine(subject),
  html: html(c),
  text: text(c),
});

interface When {
  when: string;
  zone: string;
}
function when(f: { startsAt: string; timezone?: string }): When {
  return {
    when: formatWhen(f.startsAt, f.timezone),
    zone: zoneLabel(f.startsAt, f.timezone),
  };
}

const PATIENT_WHY =
  "You are getting this because staff at Idyllic Clinic, a demonstration made for an assessment and not a real clinic, changed an appointment of yours.";
const appointmentsLink = {
  label: "See my appointments",
  href: `${SITE.bookingUrl}/appointments`,
};

function visit(f: AppointmentFacts, w: When): BoxLine[] {
  return [
    { text: w.when, strong: true },
    { text: f.doctor },
    { text: `${w.zone}, ${APPOINTMENT_MINUTES} minutes.`, muted: true },
  ];
}

/** Staff booked a visit for the patient. */
export function staffBooked(f: AppointmentFacts & WithReason): Composed {
  const w = when(f);
  return compose(`Your appointment has been booked: ${w.when}`, {
    preview: `${w.when} with ${f.doctor}`,
    heading: "You have been booked",
    lead: `Hello ${f.name}, the clinic has booked a visit for you.`,
    box: visit(f, w),
    reason: f.reason,
    reasonLabel: "Reason from the clinic",
    button: appointmentsLink,
    why: PATIENT_WHY,
  });
}

/** Staff moved the visit. `previousStartsAt` is the old time (`previous_starts_at`). */
export function staffRescheduled(
  f: AppointmentFacts & WithReason & { previousStartsAt?: string | null },
): Composed {
  const w = when(f);
  const box = visit(f, w);
  if (f.previousStartsAt)
    box.unshift({
      text: formatWhen(f.previousStartsAt, f.timezone),
      strike: true,
      label: "Was",
    });
  return compose(`Your appointment has been moved to ${w.when}`, {
    preview: `Now ${w.when} with ${f.doctor}`,
    heading: "Your appointment was moved",
    lead: `Hello ${f.name}, the clinic has given your visit a new time.`,
    box,
    reason: f.reason,
    reasonLabel: "Reason from the clinic",
    button: appointmentsLink,
    why: PATIENT_WHY,
  });
}

/** Staff cancelled the visit. `startsAt` is the time that was cancelled. */
export function staffCancelled(f: AppointmentFacts & WithReason): Composed {
  const w = when(f);
  return compose(`Your appointment on ${w.when} has been cancelled`, {
    preview: `Cancelled: ${w.when} with ${f.doctor}`,
    heading: "Your appointment was cancelled",
    lead: `Hello ${f.name}, the clinic has cancelled this visit.`,
    box: visit(f, w),
    reason: f.reason,
    reasonLabel: "Reason from the clinic",
    button: { label: "Book another visit", href: `${SITE.bookingUrl}/book` },
    why: PATIENT_WHY,
  });
}

/**
 * Staff reversed the patient's own last change (a cancel or a move) and locked the visit.
 * `startsAt` is the time the visit is back on; `previousStartsAt`, when given, is the time the
 * patient had moved it to. The wording says plainly what happened and why, and does not blame.
 */
export function staffVetoed(
  f: AppointmentFacts & WithReason & { previousStartsAt?: string | null },
): Composed {
  const w = when(f);
  const box = visit(f, w);
  if (f.previousStartsAt)
    box.unshift({
      text: formatWhen(f.previousStartsAt, f.timezone),
      strike: true,
      label: "The change that was reversed",
    });
  return compose(`Your appointment on ${w.when} has been restored`, {
    preview: `Back on ${w.when} with ${f.doctor}`,
    heading: "Your appointment is back as it was",
    lead: `Hello ${f.name}, the clinic has reversed the recent change to your appointment, so your visit is back as it was.`,
    box,
    reason: f.reason,
    reasonLabel: "Why the clinic did this",
    extra: [
      "Your visit is now locked, so it can no longer be changed online. If you need to change it, please contact the clinic.",
    ],
    button: appointmentsLink,
    why: PATIENT_WHY,
  });
}

/** "Send a reminder now". `reason` is optional: the API records a standard line when staff give none. */
export function staffRemind(
  f: AppointmentFacts & { reason?: string | null },
): Composed {
  const w = when(f);
  return compose(`Reminder: your appointment on ${w.when}`, {
    preview: `Coming up: ${w.when} with ${f.doctor}`,
    heading: "A reminder of your appointment",
    lead: `Hello ${f.name}, the clinic is reminding you of your visit.`,
    box: visit(f, w),
    reason: f.reason ?? undefined,
    reasonLabel: "Note from the clinic",
    button: { label: "Move or cancel it", href: appointmentsLink.href },
    why: "You are getting this because staff at Idyllic Clinic, a demonstration made for an assessment and not a real clinic, sent you a reminder.",
  });
}

/** How late a doctor can be reported: whole minutes, 5 to 240. */
export const LATE_MINUTES = { min: 5, max: 240 } as const;

export type RunningLateMail =
  { ok: true; mail: Composed } | { ok: false; error: "INVALID_MINUTES" };

/**
 * The doctor is running late today. `minutes` must be a whole number from 5 to 240; anything else
 * (NaN, a fraction, zero, a huge number) gives `{ ok: false, error: "INVALID_MINUTES" }` and no email.
 */
export function staffRunningLate(
  f: AppointmentFacts & { minutes: number; reason?: string | null },
): RunningLateMail {
  const m = f.minutes;
  if (!Number.isInteger(m) || m < LATE_MINUTES.min || m > LATE_MINUTES.max)
    return { ok: false, error: "INVALID_MINUTES" };
  const w = when(f);
  const mins = `${m} minutes`;
  return {
    ok: true,
    mail: compose(`${f.doctor} is running about ${mins} late today`, {
      preview: `Your ${w.when} visit may start about ${mins} later`,
      heading: "Your doctor is running late",
      lead: `Hello ${f.name}, ${f.doctor} is running about ${mins} behind today. Your visit may start a little later than planned. We are sorry for the wait.`,
      box: visit(f, w),
      reason: f.reason ?? undefined,
      reasonLabel: "Note from the clinic",
      button: appointmentsLink,
      why: "You are getting this because staff at Idyllic Clinic, a demonstration made for an assessment and not a real clinic, told today's patients of your doctor about the delay.",
    }),
  };
}

/**
 * An invitation to the admin app. The raw token goes in the URL path only (`/invite/<token>` on the
 * admin origin from SITE.url, never from a request); it is not echoed anywhere else in the email
 * and must not be logged by the caller. `expiresAt` is `expires_at` from the invite.
 */
export function staffInvite(f: {
  role: "admin" | "viewer";
  token: string;
  expiresAt: string;
}): Composed {
  const link = `${SITE.url}/invite/${encodeURIComponent(f.token)}`;
  const until = `${formatWhen(f.expiresAt)}, ${zoneLabel(f.expiresAt)}`;
  const what =
    f.role === "admin"
      ? "an admin, who can book, move and cancel appointments for patients"
      : "a viewer, who can see the dashboard with patient details hidden";
  return compose("You are invited to the Idyllic Clinic admin", {
    preview: `Accept your invitation before ${until}`,
    heading: "You are invited",
    lead: `You have been invited to the Idyllic Clinic admin as ${what}.`,
    box: [
      { text: `Role: ${f.role}`, strong: true },
      { text: `Open until ${until}`, muted: true },
    ],
    extra: [
      "Sign in with Google using the email address this message came to. The link works once and only for that address.",
    ],
    button: { label: "Accept the invitation", href: link },
    why: "You are getting this because a member of staff at Idyllic Clinic, a demonstration made for an assessment and not a real clinic, invited you.",
  });
}

/** The patient's first name and the first letter of the last one: "Amina W.". Nothing else about
 *  the patient goes to the doctor's inbox. */
export function firstNameAndInitial(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A patient";
  if (parts.length === 1) return parts[0];
  const last = [...parts[parts.length - 1]][0]?.toUpperCase() ?? "";
  return `${parts[0]} ${last}.`;
}

const DOCTOR_WHY =
  "You are getting this because the clinic's reception marked a patient of yours as arrived on the Idyllic Clinic admin dashboard, and your address is set as the doctor's contact there. Idyllic Clinic is a demonstration made for an assessment and not a real clinic.";

/**
 * "Patient arrived", to the doctor. The patient is the first name and the last initial, the time is
 * the visit's in the clinic's zone, and the link opens the appointment in the admin (which asks the
 * doctor's staff login for the rest). No phone, email, notes or reason: the inbox is not a place
 * for them.
 */
export function doctorArrived(f: {
  /** The patient's full name as the API returned it; only the first name and last initial are used. */
  patientName: string;
  /** `doctor_name`. */
  doctor: string;
  startsAt: string;
  timezone?: string;
  appointmentId: string;
}): Composed {
  const who = firstNameAndInitial(f.patientName);
  const w = when(f);
  return compose(`${who} has arrived for ${w.when}`, {
    preview: `${who} is here for the ${w.when} visit`,
    heading: "A patient has arrived",
    lead: `Hello ${f.doctor}, ${who} has arrived and is waiting for you.`,
    box: [
      { text: who, strong: true },
      { text: w.when },
      { text: `${w.zone}, ${APPOINTMENT_MINUTES} minutes.`, muted: true },
    ],
    button: {
      label: "Open the appointment",
      href: `${SITE.url}/dashboard/appointments/${encodeURIComponent(f.appointmentId)}`,
    },
    why: DOCTOR_WHY,
  });
}

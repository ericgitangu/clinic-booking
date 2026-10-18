import { DOCTOR_AVATAR_DATA } from "./doctor-avatar-data";

// Avatars keyed by the seeded doctor id (backend/app/scripts/seed.py: uuid5 of "doctor:<key>").
// The art is CC0 (DiceBear Lorelei, Lisa Wischofsky); see packages/ui/assets/doctors/README.md.
export const DOCTOR_AVATARS: Readonly<Record<string, string>> =
  DOCTOR_AVATAR_DATA;

/** Self-hosted data URI for a doctor id, or null when there is no avatar for it. */
export function doctorAvatarSrc(doctorId: string): string | null {
  return Object.hasOwn(DOCTOR_AVATARS, doctorId)
    ? DOCTOR_AVATARS[doctorId]!
    : null;
}

/** "Dr. Achieng Otieno" -> "AO". Skips the title; falls back to "?" for an empty name. */
export function doctorInitials(name: string): string {
  const words = name
    .replace(/^dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : "";
  return (first + last).toUpperCase();
}

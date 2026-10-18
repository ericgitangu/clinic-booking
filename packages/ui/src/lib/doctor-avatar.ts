import { DOCTOR_AVATAR_FILES } from "./doctor-avatar-data";

// Avatars keyed by the seeded doctor id (backend/app/scripts/seed.py: uuid5 of "doctor:<key>").
// The art lives in packages/ui/assets/doctors/ and is served as a static file by each app (see
// scripts/avatars/sync.mjs), never inlined into a JavaScript chunk. Art licence: assets/doctors/README.md.
export const DOCTOR_AVATARS: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(DOCTOR_AVATAR_FILES).map(([id, ext]) => [
      id,
      `/doctors/${id}.${ext}`,
    ]),
  );

/** Static URL (/doctors/<id>.<ext>) for a doctor id, or null when there is no avatar for it. */
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

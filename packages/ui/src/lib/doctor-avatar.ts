import { DOCTOR_AVATAR_FILES } from "./doctor-avatar-data";

// Avatars keyed by the seeded doctor id (backend/app/scripts/seed.py: uuid5 of "doctor:<key>").
// The art lives in packages/ui/assets/doctors/ and is served as a static file by each app (see
// scripts/avatars/sync.mjs), never inlined into a JavaScript chunk. Art licence: assets/doctors/README.md.
const FILES = DOCTOR_AVATAR_FILES;

/** The fallback illustration per doctor id (/doctors/<id>.<ext>); the portrait is doctorPhoto(). */
export const DOCTOR_AVATARS: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(FILES)
      .filter(([, f]) => f.fallback !== null)
      .map(([id, f]) => [id, `/doctors/${id}.${f.fallback}`]),
  );

/** Static URL of the fallback illustration, or null when there is none for this id. */
export function doctorAvatarSrc(doctorId: string): string | null {
  return Object.hasOwn(DOCTOR_AVATARS, doctorId)
    ? DOCTOR_AVATARS[doctorId]!
    : null;
}

/** The portrait as src (256 px, 1x) and srcSet (256 px 1x, 512 px 2x), or null when there is none. */
export function doctorPhoto(
  doctorId: string,
): { src: string; srcSet: string } | null {
  if (!Object.hasOwn(FILES, doctorId) || !FILES[doctorId]!.photo) return null;
  const base = `/doctors/${doctorId}`;
  return {
    src: `${base}-256.webp`,
    srcSet: `${base}-256.webp 1x, ${base}-512.webp 2x`,
  };
}

/** Said on hover and to screen readers (as the image's description; the alt text stays the name). */
export const PORTRAIT_DISCLOSURE =
  "AI-generated portrait of a fictional doctor";
export const ILLUSTRATION_DISCLOSURE = "Illustration of a fictional doctor";

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

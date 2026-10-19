// Written by scripts/avatars/sync.mjs from packages/ui/assets/doctors/. Edit the art there, not this file.
// Per doctor id: the extension of the fallback file (/doctors/<id>.<ext>) and whether the portrait
// (/doctors/<id>-256.webp and -512.webp) exists. All are served from each app's public/ directory.
export type DoctorAvatarFiles = { fallback: string | null; photo: boolean };
export const DOCTOR_AVATAR_FILES: Readonly<Record<string, DoctorAvatarFiles>> =
  {
    "412e6793-68f2-5c62-832d-cb7839acae9d": { fallback: "svg", photo: true },
    "b465c5a0-40d4-5871-9606-c7a460b7e8b0": { fallback: "svg", photo: true },
    "ceae880b-86c2-562d-978c-ac7794404e04": { fallback: "svg", photo: true },
    "d761df1a-d923-5bb3-bf78-057823782bc2": { fallback: "svg", photo: true },
    "e52e9da0-f7f3-5a6a-93d3-d7f658947afa": { fallback: "svg", photo: true },
  };

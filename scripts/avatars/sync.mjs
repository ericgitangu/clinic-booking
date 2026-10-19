// Publishes the doctor avatars as static files. No dependencies; run it after adding or replacing a
// file in packages/ui/assets/doctors/ (generate.mjs calls it for you):
//
//   node scripts/avatars/sync.mjs
//
// The art in packages/ui/assets/doctors/ is the source of truth, per doctor id:
//   <id>-128.webp, <id>-256.webp and <id>-512.webp   the portrait (128 w for small avatars, 256 w, 512 w); all three or none
//   <id>.svg (or .png, .jpg, .jpeg, .avif, .webp)   the fallback shown if the portrait fails to load
// This copies every file to apps/<app>/public/doctors/ (served as /doctors/<file>, so no image bytes
// are inlined into any JavaScript chunk) and writes the manifest DoctorAvatar reads
// (packages/ui/src/lib/doctor-avatar-data.ts). A test keeps source, manifest and both copies in step.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, "packages", "ui", "assets", "doctors");
const manifest = join(root, "packages", "ui", "src", "lib", "doctor-avatar-data.ts");
// The admin app does not show doctors, so it does not ship their images; add it here if it starts to.
const APPS = ["booking"];
const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const FALLBACK = new RegExp(`^${ID}\\.(svg|webp|png|jpe?g|avif)$`);
const PHOTO = new RegExp(`^${ID}-(128|256|512)\\.webp$`);

const files = readdirSync(src).sort();
const fallbacks = new Map(); // id -> extension
const photos = new Map(); // id -> Set of sizes
for (const f of files) {
  const p = PHOTO.exec(f);
  if (p) {
    photos.set(p[1], (photos.get(p[1]) ?? new Set()).add(p[2]));
    continue;
  }
  const m = FALLBACK.exec(f);
  if (!m) continue;
  if (fallbacks.has(m[1])) throw new Error(`two fallback files for ${m[1]}: keep one extension per doctor`);
  fallbacks.set(m[1], m[2]);
}
for (const [id, sizes] of photos) {
  if (!(sizes.has("128") && sizes.has("256") && sizes.has("512"))) throw new Error(`${id}: a portrait needs -128.webp, -256.webp and -512.webp`);
}
const ids = [...new Set([...fallbacks.keys(), ...photos.keys()])].sort();
const copied = files.filter((f) => PHOTO.test(f) || FALLBACK.test(f));

for (const app of APPS) {
  const out = join(root, "apps", app, "public", "doctors");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of copied) copyFileSync(join(src, f), join(out, f));
}

const row = (id) =>
  `  "${id}": { fallback: ${fallbacks.has(id) ? `"${fallbacks.get(id)}"` : "null"}, photo: ${photos.has(id)} },`;
writeFileSync(
  manifest,
  `// Written by scripts/avatars/sync.mjs from packages/ui/assets/doctors/. Edit the art there, not this file.\n` +
    `// Per doctor id: the extension of the fallback file (/doctors/<id>.<ext>) and whether the portrait\n` +
    `// (/doctors/<id>-128.webp, -256.webp and -512.webp) exists. All are served from each app's public/ directory.\n` +
    `export type DoctorAvatarFiles = { fallback: string | null; photo: boolean };\n` +
    `export const DOCTOR_AVATAR_FILES: Readonly<Record<string, DoctorAvatarFiles>> = {\n${ids.map(row).join("\n")}\n};\n`,
);
console.log(`synced ${ids.length} doctors, ${copied.length} files, to ${APPS.length} apps`);

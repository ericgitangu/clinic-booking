// Publishes the doctor avatars as static files. No dependencies; run it after adding or replacing a
// file in packages/ui/assets/doctors/ (generate.mjs calls it for you):
//
//   node scripts/avatars/sync.mjs
//
// The art in packages/ui/assets/doctors/<doctor id>.<ext> (svg, webp, png, jpg, jpeg or avif) is the
// source of truth. This copies each file to apps/<app>/public/doctors/ (served as /doctors/<id>.<ext>,
// so no image bytes are inlined into any JavaScript chunk) and writes the id to extension manifest
// that DoctorAvatar reads (packages/ui/src/lib/doctor-avatar-data.ts). A test keeps all three in step.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, "packages", "ui", "assets", "doctors");
const manifest = join(root, "packages", "ui", "src", "lib", "doctor-avatar-data.ts");
const APPS = ["booking", "admin"];
const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(svg|webp|png|jpe?g|avif)$/;

const found = readdirSync(src)
  .map((f) => FILE.exec(f))
  .filter((m) => m !== null)
  .sort((a, b) => a[1].localeCompare(b[1]));

const ids = new Set();
for (const m of found) {
  if (ids.has(m[1])) throw new Error(`two avatar files for ${m[1]}: keep one extension per doctor`);
  ids.add(m[1]);
}

for (const app of APPS) {
  const out = join(root, "apps", app, "public", "doctors");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [file] of found) copyFileSync(join(src, file), join(out, file));
}

const lines = found.map((m) => `  "${m[1]}": "${m[2]}",`);
writeFileSync(
  manifest,
  `// Written by scripts/avatars/sync.mjs from packages/ui/assets/doctors/. Edit the art there, not this file.\n` +
    `// Doctor id -> file extension; the file is served as /doctors/<id>.<ext> from each app's public/ directory.\n` +
    `export const DOCTOR_AVATAR_FILES: Readonly<Record<string, string>> = {\n${lines.join("\n")}\n};\n`,
);
console.log(`synced ${found.length} avatars to ${APPS.length} apps`);

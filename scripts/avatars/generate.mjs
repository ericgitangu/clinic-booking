// Dev-time generator for the doctor avatars. Output is committed; nothing here runs in the apps.
//
//   cd scripts/avatars && npm ci --ignore-scripts && node generate.mjs [--preview <file.html>]
//
// Art: DiceBear "Lorelei" by Lisa Wischofsky, CC0 1.0 (see packages/ui/assets/doctors/README.md).
// Every option is pinned per person, so the output does not depend on a seed or on randomness.
// Ids are the seed's deterministic uuid5 values (backend/app/scripts/seed.py, NAMESPACE + "doctor:<key>").
import { createAvatar } from "@dicebear/core";
import * as lorelei from "@dicebear/lorelei";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "packages", "ui", "assets", "doctors");
const moduleOut = join(root, "packages", "ui", "src", "lib", "doctor-avatar-data.ts");

// Shared across all five: same style, same background, same line and hair colour.
const COMMON = {
  backgroundColor: ["dfe8f1"],
  hairColor: ["1b1b1b"],
  eyebrowsColor: ["1b1b1b"],
  eyesColor: ["1b1b1b"],
  noseColor: ["1b1b1b"],
  mouthColor: ["1b1b1b"],
  glassesColor: ["1b1b1b"],
  beardProbability: 0,
  glassesProbability: 0,
  earringsProbability: 0,
  frecklesProbability: 0,
  hairAccessoriesProbability: 0,
  mouth: ["happy01"],
};

export const DOCTORS = [
  { key: "otieno", id: "e52e9da0-f7f3-5a6a-93d3-d7f658947afa", name: "Dr. Achieng Otieno",
    opts: { skinColor: ["8d5524"], hair: ["variant26"], head: ["variant01"], eyes: ["variant10"], nose: ["variant02"], eyebrows: ["variant03"], earringsProbability: 100, earrings: ["variant01"], earringsColor: ["1b1b1b"] } },
  { key: "kamau", id: "412e6793-68f2-5c62-832d-cb7839acae9d", name: "Dr. Brian Kamau",
    opts: { skinColor: ["7a4a24"], hair: ["variant01"], head: ["variant02"], eyes: ["variant02"], nose: ["variant03"], eyebrows: ["variant06"] } },
  { key: "rotich", id: "d761df1a-d923-5bb3-bf78-057823782bc2", name: "Dr. Chebet Rotich",
    opts: { skinColor: ["9a6330"], hair: ["variant13"], head: ["variant03"], eyes: ["variant08"], nose: ["variant01"], eyebrows: ["variant07"] } },
  { key: "mwangi", id: "b465c5a0-40d4-5871-9606-c7a460b7e8b0", name: "Dr. David Mwangi",
    opts: { skinColor: ["6b3f1f"], hair: ["variant39"], head: ["variant04"], eyes: ["variant24"], nose: ["variant05"], eyebrows: ["variant02"], glassesProbability: 100, glasses: ["variant04"] } },
  { key: "njeri", id: "ceae880b-86c2-562d-978c-ac7794404e04", name: "Dr. Esther Njeri",
    opts: { skinColor: ["80501f"], hair: ["variant24"], head: ["variant01"], eyes: ["variant16"], nose: ["variant04"], eyebrows: ["variant08"], earringsProbability: 100, earrings: ["variant02"], earringsColor: ["1b1b1b"] } },
];

mkdirSync(outDir, { recursive: true });
const svgs = DOCTORS.map((d) => {
  // seed is fixed to the id only so DiceBear's own PRNG is stable; every visible option is pinned.
  const svg = createAvatar(lorelei, { ...COMMON, ...d.opts, seed: d.id, size: 128 }).toString();
  writeFileSync(join(outDir, `${d.id}.svg`), svg + "\n");
  return { ...d, svg };
});

// The apps consume the art as data URIs from this module, so no public-dir copy or CDN is needed
// and both Next apps resolve it through @clinic/ui. A test keeps it in sync with the .svg files.
// Layout matches prettier's output so the committed file is stable under lint-staged.
const lines = svgs.map(
  (d) => `  // ${d.name}\n  "${d.id}":\n    "data:image/svg+xml;base64,${Buffer.from(d.svg + "\n").toString("base64")}",`,
);
writeFileSync(
  moduleOut,
  `// Written by scripts/avatars/generate.mjs from packages/ui/assets/doctors/*.svg. Edit the generator, not this file.\n` +
    `// Art: DiceBear Lorelei by Lisa Wischofsky, CC0 1.0.\n` +
    `export const DOCTOR_AVATAR_DATA: Readonly<Record<string, string>> = {\n${lines.join("\n")}\n};\n`,
);

const i = process.argv.indexOf("--preview");
if (i > -1) {
  const cells = svgs.map(
    (d) => `<figure style="margin:8px;text-align:center;font:14px sans-serif"><div style="width:200px;height:200px;border-radius:50%;overflow:hidden">${d.svg.replace('width="128"','width="200"').replace('height="128"','height="200"')}</div><figcaption>${d.name}</figcaption></figure>`,
  );
  writeFileSync(process.argv[i + 1], `<body style="margin:8px;display:flex;flex-wrap:wrap;width:1100px">${cells.join("")}</body>`);
}
console.log(`wrote ${svgs.length} avatars`);

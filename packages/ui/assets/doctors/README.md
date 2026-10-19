# Doctor avatars

One portrait and one illustration per seeded doctor, named by the doctor's id
(`backend/app/scripts/seed.py`: uuid5 of `doctor:<key>`).

| Id | Doctor |
| --- | --- |
| `e52e9da0-f7f3-5a6a-93d3-d7f658947afa` | Dr. Achieng Otieno |
| `412e6793-68f2-5c62-832d-cb7839acae9d` | Dr. Brian Kamau |
| `d761df1a-d923-5bb3-bf78-057823782bc2` | Dr. Chebet Rotich |
| `b465c5a0-40d4-5871-9606-c7a460b7e8b0` | Dr. David Mwangi |
| `ceae880b-86c2-562d-978c-ac7794404e04` | Dr. Esther Njeri |

## Portraits (AI-generated)

Each doctor has a photorealistic portrait: `<id>-256.webp` and `<id>-512.webp` (about 5 KB and 13 KB).
They are **AI-generated portraits of fictional doctors**. They are not photographs of real people, and the
seeded doctors do not exist. The app says so on the doctor list, and each portrait carries that sentence as
its description (the image's `title`, which screen readers read and hovering shows); the alt text stays the
doctor's name.

- Model: Z-Image-Turbo (`Tongyi-MAI/Z-Image-Turbo`), run on 2026-10-18 through the Hugging Face Space
  `mcp-tools/Z-Image-Turbo`, which loads that model.
- Settings: 1024 x 1024, 8 steps, shift 3.0, fixed seed 2026, so the run can be repeated.
- Prompt template, with `{who}` and `{wear}` filled in per doctor from the table below:
  "Professional corporate headshot photograph, {who}, wearing a crisp white doctor's coat over {wear}, stethoscope around neck, warm genuine smile, looking at camera, soft even studio lighting, plain light grey background, head and shoulders, centered, sharp focus, photorealistic, 85mm lens"

| Doctor | {who} | {wear} |
| --- | --- | --- |
| Dr. Achieng Otieno | a Kenyan Black woman in her late 30s, general practitioner, short natural hair, small gold stud earrings | navy blouse |
| Dr. Brian Kamau | a Kenyan Black man in his mid 30s, paediatrician, short cropped hair, friendly expression | light blue shirt |
| Dr. Chebet Rotich | a Kenyan Black woman in her early 30s, dermatologist, neat braids tied back, clear radiant skin | teal scrubs |
| Dr. David Mwangi | a Kenyan Black man in his late 40s, obstetrician gynaecologist, short greying hair, trimmed beard, reassuring expression | white shirt and dark tie |
| Dr. Esther Njeri | a Kenyan Black woman in her early 40s, dentist, shoulder-length relaxed hair, bright smile | lilac scrubs |

- Derivatives: WebP at 256 and 512 px (ImageMagick, quality 82, metadata stripped). The 1024 px originals are
  not kept in the repository. `scripts/avatars/portraits.py` (`make avatars`) repeats the run; it reads a
  cached Hugging Face login and never writes the token anywhere.
- Model licence: **Apache License 2.0**. The model card (`Tongyi-MAI/Z-Image-Turbo`,
  <https://huggingface.co/Tongyi-MAI/Z-Image-Turbo>) declares `license: apache-2.0` in its metadata
  (card data), confirmed with the Hugging Face CLI on 2026-10-19 against model revision `f332072aa78be7aecdf3ee76d5c247082da564a6`. The Space `mcp-tools/Z-Image-Turbo` is listed as running that
  model. The project's licence text is at <https://github.com/Tongyi-MAI/Z-Image/blob/main/LICENSE>. The card is
  not gated and adds no terms about generated images. Apache 2.0 allows commercial use and puts no
  restriction on what is made with the model, so using the outputs in this portfolio and in a commercial
  product is permitted. This is a reading of the published licence, not legal advice.

The illustrations below (`<id>.svg`) stay as the fallback shown if a portrait fails to load; if that fails too,
the app shows the doctor's initials.

## Licence

Art: DiceBear "Lorelei", designed by Lisa Wischofsky, CC0 1.0 Universal.

- Source: <https://www.figma.com/community/file/1198749693280469639>
- DiceBear's licence page (<https://www.dicebear.com/licenses/>) lists Lorelei as "Remix of Lorelei by
  Lisa Wischofsky" under CC0 1.0, with no attribution required.
- The licence file shipped in the `@dicebear/lorelei` package says, for all design files: "Source: Lorelei,
  Designer: Lisa Wischofsky, License: CC0 1.0 (<https://creativecommons.org/publicdomain/zero/1.0/>)". Only
  the package code is MIT; the generator packages are dev-time only and are not shipped.
- CC0 asks that the work not be presented as endorsed by its author. These portraits are not.

The generated SVGs carry the CC0 rights notice in their own metadata.

## How the apps use them

The files here are the source of truth: per doctor id, `<id>-256.webp` and `<id>-512.webp` (the portrait,
1x and 2x) and `<id>.svg` (the fallback). `node scripts/avatars/sync.mjs` copies them to
`apps/booking/public/doctors/` and `apps/admin/public/doctors/` (served as `/doctors/<file>`, so no image
bytes are inlined into any JavaScript chunk) and writes the manifest `packages/ui/src/lib/doctor-avatar-data.ts`
that `DoctorAvatar` reads. `DoctorAvatar` shows the portrait (`srcset` 256 w and 512 w with `sizes` set to the displayed width, explicit width and
height), then the SVG if the portrait fails, then initials. A unit test fails if the sources, the manifest and
the app copy drift apart. To change a portrait, replace both WebP sizes and run the sync.

## Regenerate

Every option is pinned per person in `scripts/avatars/generate.mjs`, so the output is deterministic.

```sh
cd scripts/avatars
npm ci --ignore-scripts
node generate.mjs                          # rewrites the SVGs, then runs the sync
node generate.mjs --preview /tmp/doctors.html   # optional contact sheet
```

Versions are pinned to `@dicebear/core@9.4.2` and `@dicebear/lorelei@9.4.2`. The generator is not part of
the pnpm workspace and is never bundled.

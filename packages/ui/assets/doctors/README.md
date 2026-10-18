# Doctor avatars

One illustrated portrait per seeded doctor, named by the doctor's id
(`backend/app/scripts/seed.py`: uuid5 of `doctor:<key>`).

| Id | Doctor |
| --- | --- |
| `e52e9da0-f7f3-5a6a-93d3-d7f658947afa` | Dr. Achieng Otieno |
| `412e6793-68f2-5c62-832d-cb7839acae9d` | Dr. Brian Kamau |
| `d761df1a-d923-5bb3-bf78-057823782bc2` | Dr. Chebet Rotich |
| `b465c5a0-40d4-5871-9606-c7a460b7e8b0` | Dr. David Mwangi |
| `ceae880b-86c2-562d-978c-ac7794404e04` | Dr. Esther Njeri |

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

The files here (`<doctor id>.svg`, or `.webp`, `.png`, `.jpg`, `.avif`) are the source of truth.
`node scripts/avatars/sync.mjs` copies them to `apps/booking/public/doctors/` and
`apps/admin/public/doctors/` (served as `/doctors/<id>.<ext>`, so no image bytes are inlined into any
JavaScript chunk) and writes the id to extension manifest `packages/ui/src/lib/doctor-avatar-data.ts`
that `DoctorAvatar` reads. A unit test fails if the three drift apart. To swap the art for photos, drop
`<id>.webp` files here (one extension per doctor), delete the old file, and run the sync.

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

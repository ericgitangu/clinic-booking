import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DoctorAvatar,
  DoctorAvatarView,
} from "../src/components/doctor-avatar";
import {
  DOCTOR_AVATARS,
  doctorAvatarSrc,
  doctorInitials,
  doctorPhoto,
  PORTRAIT_DISCLOSURE,
} from "../src/lib/doctor-avatar";

// The seed is the truth: backend/app/scripts/seed.py (uuid5 of "doctor:<key>").
const SEEDED = {
  "e52e9da0-f7f3-5a6a-93d3-d7f658947afa": "Dr. Achieng Otieno",
  "412e6793-68f2-5c62-832d-cb7839acae9d": "Dr. Brian Kamau",
  "d761df1a-d923-5bb3-bf78-057823782bc2": "Dr. Chebet Rotich",
  "b465c5a0-40d4-5871-9606-c7a460b7e8b0": "Dr. David Mwangi",
  "ceae880b-86c2-562d-978c-ac7794404e04": "Dr. Esther Njeri",
};

describe("avatar map", () => {
  it("has an avatar for every seeded doctor id", () => {
    for (const id of Object.keys(SEEDED)) {
      expect(doctorAvatarSrc(id), id).toBe(`/doctors/${id}.svg`);
    }
    expect(Object.keys(DOCTOR_AVATARS).sort()).toEqual(
      Object.keys(SEEDED).sort(),
    );
  });

  it("has a portrait (both sizes) and a fallback illustration for every seeded id", () => {
    for (const id of Object.keys(SEEDED)) {
      expect(doctorPhoto(id), id).toEqual({
        src: `/doctors/${id}-256.webp`,
        srcSet: `/doctors/${id}-256.webp 1x, /doctors/${id}-512.webp 2x`,
      });
    }
    expect(doctorPhoto("nope")).toBeNull();
    expect(doctorPhoto("constructor")).toBeNull();
  });

  it("has one source set per id, and a byte-identical static copy of every file in each app", () => {
    const dir = fileURLToPath(new URL("../assets/doctors/", import.meta.url));
    const files = readdirSync(dir).filter((f) =>
      /\.(svg|webp|png|jpe?g|avif)$/.test(f),
    );
    const idOf = (f: string) => f.replace(/(-(256|512))?\.[^.]+$/, "");
    expect([...new Set(files.map(idOf))].sort()).toEqual(
      Object.keys(DOCTOR_AVATARS).sort(),
    );
    for (const id of Object.keys(SEEDED)) {
      for (const f of [`${id}.svg`, `${id}-256.webp`, `${id}-512.webp`])
        expect(files, f).toContain(f);
    }
    for (const app of ["booking", "admin"]) {
      const pub = fileURLToPath(
        new URL(`../../../apps/${app}/public/doctors/`, import.meta.url),
      );
      expect(readdirSync(pub).sort(), app).toEqual([...files].sort());
      for (const f of files) {
        expect(
          readFileSync(pub + f).equals(readFileSync(dir + f)),
          `${app}/${f}`,
        ).toBe(true);
      }
    }
  });

  it("never inlines image bytes", () => {
    for (const src of [
      ...Object.values(DOCTOR_AVATARS),
      ...Object.keys(SEEDED).map((id) => doctorPhoto(id)!.srcSet),
    ]) {
      expect(src).not.toContain("data:");
      expect(src.startsWith("/doctors/")).toBe(true);
      expect(src.length).toBeLessThan(140);
    }
  });

  it("returns null for an unknown id, including prototype keys", () => {
    expect(doctorAvatarSrc("nope")).toBeNull();
    expect(doctorAvatarSrc("constructor")).toBeNull();
  });
});

describe("doctorInitials", () => {
  it("skips the title", () => {
    expect(doctorInitials("Dr. Achieng Otieno")).toBe("AO");
    expect(doctorInitials("Esther")).toBe("E");
    expect(doctorInitials("")).toBe("?");
  });
});

describe("DoctorAvatar", () => {
  const [id, name] = Object.entries(SEEDED)[0]!;

  it("renders the img with the doctor's name as alt and explicit size", () => {
    const html = renderToStaticMarkup(
      <DoctorAvatar doctorId={id} name={name} size={48} />,
    );
    expect(html).toContain(`alt="${name}"`);
    expect(html).toContain('width="48"');
    expect(html).toContain('height="48"');
    expect(html).toContain("rounded-full");
    expect(html).toContain(`src="/doctors/${id}-256.webp"`);
    expect(html).toContain(
      `srcSet="/doctors/${id}-256.webp 1x, /doctors/${id}-512.webp 2x"`,
    );
    // The disclosure is the image's description (title), not part of the alt text.
    expect(html).toContain(`title="${PORTRAIT_DISCLOSURE}"`);
  });

  it("falls back to initials for an unknown id", () => {
    const html = renderToStaticMarkup(
      <DoctorAvatar doctorId="unknown" name="Dr. Zed Quinn" size={40} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="Dr. Zed Quinn"');
    expect(html).toContain(">ZQ<");
    expect(html).toContain("width:40px");
  });

  it("view swaps to initials once the image has failed, and the img reports errors", () => {
    const ok = DoctorAvatarView({
      name,
      size: 40,
      src: doctorPhoto(id)!.src,
      onError: () => {},
    });
    expect(
      isValidElement(ok) && typeof (ok.props as { onError?: unknown }).onError,
    ).toBe("function");
    const failed = renderToStaticMarkup(
      <DoctorAvatarView name={name} size={40} src={null} />,
    );
    expect(failed).not.toContain("<img");
    expect(failed).toContain(">AO<");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { PUBLIC_PATHS, SITE, THEME_COLORS } from "@/lib/site";

// The fields a browser needs before it offers "Install app", and the ones that make it look right.
describe("web app manifest", () => {
  const m = manifest();

  it("has the identity an installable app needs", () => {
    expect(m.name).toBe(SITE.name);
    expect(m.short_name).toBe(SITE.shortName);
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
    expect(m.description).toBe(SITE.description);
    expect(m.id).toBe("/");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.categories).toEqual(expect.arrayContaining(["health"]));
  });

  it("uses the page background for the splash and the theme colour, as hex", () => {
    expect(m.background_color).toBe(THEME_COLORS.light);
    expect(m.theme_color).toBe(THEME_COLORS.light);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("has 192 and 512 icons for any use and a separate maskable icon", () => {
    const icons = m.icons ?? [];
    const any = icons.filter((i) => i.purpose === "any");
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    const maskable = icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0].sizes).toBe("512x512");
    // "any maskable" in one entry is discouraged: the icon is cropped or padded wrongly.
    expect(icons.every((i) => !String(i.purpose).includes(" "))).toBe(true);
    for (const i of icons) expect(i.type).toBe("image/png");
  });

  it("offers shortcuts for booking and for my appointments, to pages that exist", () => {
    const shortcuts = m.shortcuts ?? [];
    expect(shortcuts.map((s) => s.url)).toEqual(["/book", "/appointments"]);
    for (const s of shortcuts) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.short_name!.length).toBeLessThanOrEqual(12);
    }
    expect(PUBLIC_PATHS).toContain("/book");
  });

  it("describes a wide and a narrow screenshot, with sizes and a label", () => {
    const shots = m.screenshots ?? [];
    expect(shots.map((s) => s.form_factor).sort()).toEqual(["narrow", "wide"]);
    for (const s of shots) {
      expect(s.sizes).toMatch(/^\d+x\d+$/);
      expect(s.label).toBeTruthy();
      expect(s.src.startsWith("/screenshots/")).toBe(true);
    }
  });

  it("names screenshot files that exist and have the size the manifest claims", () => {
    for (const s of m.screenshots ?? []) {
      const file = readFileSync(
        new URL(`../../public${s.src}`, import.meta.url),
      );
      // A lossy WebP: "RIFF....WEBPVP8 " then the frame header, 14 bits each for width and height.
      expect(file.toString("ascii", 0, 4)).toBe("RIFF");
      expect(file.toString("ascii", 8, 15)).toBe("WEBPVP8");
      const w = file.readUInt16LE(26) & 0x3fff;
      const h = file.readUInt16LE(28) & 0x3fff;
      expect(`${w}x${h}`, s.src).toBe(s.sizes);
    }
  });
});

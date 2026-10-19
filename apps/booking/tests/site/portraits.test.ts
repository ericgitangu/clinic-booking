import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The landing page links to the README subsection that discloses the AI-generated portraits. The
// link, the heading, and the facts stated there (prompt, per-doctor strings) are checked against
// each other and against the generator, so none of them can drift.
const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)),
    "utf8",
  );

const readme = read("README.md");
const footer = read("apps/booking/src/lib/footer-links.ts");
const landing = read("apps/booking/src/app/page.tsx");
const script = read("scripts/avatars/portraits.py");
const HEADING = "Doctor portraits (AI-generated)";

// GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens.
const slug = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

describe("the portrait disclosure", () => {
  it("is a heading in the README, and the footer link targets its anchor", () => {
    expect(readme).toMatch(
      new RegExp(`^### ${HEADING.replace(/[()]/g, "\\$&")}$`, "m"),
    );
    const anchor = slug(HEADING);
    expect(anchor).toBe("doctor-portraits-ai-generated");
    expect(footer).toContain("#" + anchor);
    expect(footer).toContain(
      'label: "AI-generated portraits of fictional doctors"',
    );
  });

  it("keeps the landing page free of the prompt text", () => {
    expect(landing).not.toContain("Professional corporate headshot");
  });

  it("states plainly that the people are fictional and that patients get no generated face", () => {
    const section = readme.slice(
      readme.indexOf(`### ${HEADING}`),
      readme.indexOf("## 7. Testing"),
    );
    expect(section).toContain("AI-generated portraits of fictional doctors");
    expect(section).toContain("Patients never get a generated face");
    expect(section).toContain("Apache License 2.0");
    expect(section).toContain(
      "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo",
    );
  });

  it("quotes the generator's prompt verbatim and its per-doctor strings exactly", () => {
    const section = readme.slice(
      readme.indexOf(`### ${HEADING}`),
      readme.indexOf("## 7. Testing"),
    );
    // The script splits the template over string literals; join them back.
    const base = script
      .slice(script.indexOf("BASE = ("), script.indexOf("# Ids are"))
      .match(/"((?:[^"\\]|\\.)*)"/g)!
      .map((s) => s.slice(1, -1))
      .join("");
    expect(section).toContain(`"${base}"`);
    for (const dict of ["DOCS", "WEAR"]) {
      const body = script.slice(script.indexOf(`${dict} = {`));
      const block = body.slice(0, body.indexOf("\n}"));
      const values = [
        ...block.matchAll(/"(?:otieno|kamau|rotich|mwangi|njeri)": "([^"]+)"/g),
      ].map((m) => m[1]!);
      expect(values).toHaveLength(5);
      for (const v of values) expect(section, v).toContain(v);
    }
  });

  it("never carries a token: the generator reads the cached login and redacts it", () => {
    expect(script).toContain("get_token()");
    expect(script).not.toMatch(/hf_[A-Za-z0-9]{20,}/);
    expect(script).toContain("[redacted]");
  });
});

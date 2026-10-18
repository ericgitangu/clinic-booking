// (admin) The self-hosted font covers the letters in Kenyan names (ũ, ĩ), not just ASCII, and the extra file
// is fetched only when a page shows one of them. Real browser, real production build.
import { expect, test } from "@playwright/test";

const NAME = "Wanjirũ Kĩmani";

test("Wanjirũ Kĩmani renders in the self-hosted font, with no fallback glyphs", async ({
  page,
}) => {
  const fontFiles: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(".woff2")) fontFiles.push(r.url());
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  // A page with only ASCII and common punctuation: the latin-ext face (the one whose range starts at
  // U+0100, which Chrome prints as U+100) is declared but never fetched, and the network agrees.
  const before = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => /U\+0*100-/.test(f.unicodeRange))
      .map((f) => f.status),
  );
  expect(before).toEqual(["unloaded"]);
  expect(fontFiles).toHaveLength(1);

  await page.evaluate(async (name) => {
    const span = document.createElement("span");
    span.id = "name-probe";
    span.textContent = name;
    span.style.cssText =
      "font-family: var(--font-sans); font-size: 32px; font-weight: 500; white-space: nowrap";
    document.body.append(span);
    const ext = [...document.fonts].find((f) =>
      /U\+0*100-/.test(f.unicodeRange),
    );
    if (!ext) throw new Error("no latin-ext face declared");
    await document.fonts.load(`500 32px "${ext.family}"`, name);
    await document.fonts.ready;
  }, NAME);
  expect(fontFiles).toHaveLength(2);

  // Which font drew each glyph, as the browser reports it (DevTools "Rendered Fonts"): every glyph of
  // the name must come from a font file served by this app, none from a system fallback.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#name-probe",
  });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.reduce((n, f) => n + f.glyphCount, 0)).toBe([...NAME].length);
  for (const f of fonts) expect(f.isCustomFont, f.familyName).toBe(true);
  // The two accented letters come from the ext file, the rest from the latin one.
  expect(fonts.find((f) => f.familyName === "latinExt")?.glyphCount).toBe(2);
});

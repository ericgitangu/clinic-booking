// (admin) The self-hosted font covers the letters in Kenyan names (ĩ, ũ) as well as ASCII, and the second
// (latin-ext) file is fetched only when a page shows a letter that needs it. Real browser, real
// production build.
import { expect, test, type Page } from "@playwright/test";

const NAME = "Wanjirũ Kĩmani";
// Ę and Ł are only in the latin-ext file (checked against its cmap), so drawing them needs that file.
const EXT_TEXT = "Ędwin Łukasz";

async function show(page: Page, id: string, text: string) {
  await page.evaluate(
    async ([probe, content]) => {
      const span = document.createElement("span");
      span.id = probe;
      span.textContent = content;
      span.style.cssText =
        "display: block; font-family: var(--font-sans); font-size: 32px; font-weight: 500; white-space: nowrap";
      document.body.append(span);
      await document.fonts.load('500 32px "latin"', content);
      await document.fonts.load('500 32px "latinExt"', content);
      await document.fonts.ready;
    },
    [id, text],
  );
}

// Which font drew each glyph, as the browser reports it (DevTools "Rendered Fonts").
async function drawnBy(page: Page, id: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: `#${id}`,
  });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts;
}

test("Wanjirũ Kĩmani renders in the self-hosted font, with no fallback glyphs", async ({
  page,
}) => {
  const fontFiles = new Set<string>();
  page.on("request", (r) => {
    if (r.url().endsWith(".woff2")) fontFiles.add(r.url());
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  // The latin face is font-display: optional, so on a cold first view the browser may keep a system
  // font for the page when the file is slow (a loaded CI runner). That is the intended trade, but it
  // would make this check depend on timing. Reload so the file comes from cache, as every repeat
  // view does, then measure.
  await page.reload();
  await page.evaluate(() => document.fonts.ready);

  const extStatus = () =>
    page.evaluate(() =>
      [...document.fonts]
        .filter((f) => /U\+0*100-/.test(f.unicodeRange))
        .map((f) => f.status),
    );

  await show(page, "name-probe", NAME);
  const name = await drawnBy(page, "name-probe");
  // Every glyph, the tilde letters included, comes from a font file this app serves.
  expect(name.length).toBeGreaterThan(0);
  for (const f of name) expect(f.isCustomFont, f.familyName).toBe(true);
  expect(name.reduce((n, f) => n + f.glyphCount, 0)).toBeGreaterThanOrEqual(
    [...NAME].length,
  );
  // ...and the Kikuyu name does not cost a second download.
  expect(await extStatus()).toEqual(["unloaded"]);
  expect(fontFiles.size).toBe(1);

  // A letter that only the latin-ext file has pulls that file in, and is drawn from it.
  await show(page, "ext-probe", EXT_TEXT);
  const ext = await drawnBy(page, "ext-probe");
  for (const f of ext) expect(f.isCustomFont, f.familyName).toBe(true);
  expect(ext.reduce((n, f) => n + f.glyphCount, 0)).toBe([...EXT_TEXT].length);
  expect(await extStatus()).toEqual(["loaded"]);
  expect(fontFiles.size).toBe(2);
});

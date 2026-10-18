// The self-hosted font covers the letters in Kenyan names (ĩ, ũ) as well as ASCII, and the second
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
  // FONTS_E2E_CPU_THROTTLE=4 slows the browser's CPU four times, to model a slow CI runner. Unset,
  // nothing changes.
  const throttle = Number(process.env.FONTS_E2E_CPU_THROTTLE ?? 1);
  if (throttle > 1) {
    const slow = await page.context().newCDPSession(page);
    await slow.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  // Every font file arrives 1.5 s late, far past the optional block period, so the test proves it
  // does not depend on how fast the machine is (before this, a slow runner kept a system font).
  await page.route("**/*.woff2", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  // The latin face is font-display: optional: if its file is not ready within the first ~100 ms of a
  // view, Chrome keeps a system font for the whole view. That is the intended trade for visitors, but
  // it makes a glyph check depend on how fast the machine is (a loaded CI runner failed it). So the
  // test takes the timing out: it sets the same two @font-face rules (same files, same unicode-range)
  // to swap through the CSSOM, which makes the browser use each face as soon as it has loaded, and
  // loads both faces before measuring. The files, their ranges and which one draws which letter are
  // exactly what ships.
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSFontFaceRule) {
          rule.style.setProperty("font-display", "swap");
        }
      }
    }
  });

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

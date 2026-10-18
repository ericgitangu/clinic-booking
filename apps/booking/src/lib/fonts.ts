import localFont from "next/font/local";

// Atkinson Hyperlegible Next (SIL OFL 1.1, licence in src/fonts/OFL.txt), variable weight, committed so
// the build needs no network. Two files with a unicode-range each, as Google serves them: the latin file
// covers ASCII and common punctuation, the latin-ext file covers letters such as the ũ and ĩ in Kenyan
// names. The browser downloads the ext file only when a page uses one of its characters. The ranges are
// literals and every option is written out per call: next/font reads them at build time and cannot
// follow a constant or a spread.
// Kikuyu letters (ĩ ũ and capitals) are not in this font as single characters, and Google's subsets
// leave them in the ext range, where the ext file has no glyph for them (they then fell back to the
// system font). The font does have u, i and a combining tilde (U+0303) with mark positioning in the
// latin file, so the shaper builds them from those. Hence U+0128-0129, U+0168-0169 and U+0303 are
// claimed by the latin face and cut out of the ext range.
//
// Neither family carries a fallback: the system fonts are appended once, after both (see fontVars).
// The latin family must come first in the stack: the browser fetches the first family to measure the
// line, and putting the ext family first made every page download it.
const latinExt = localFont({
  weight: "200 800",
  style: "normal",
  // No metrics are published for this font, so Next cannot size a fallback.
  adjustFontFallback: false,
  src: "../fonts/AtkinsonHyperlegibleNext-latin-ext-wght.woff2",
  // Swap, not optional: this file is requested late (only when a page shows such a letter), and with
  // optional the browser would keep the fallback for that whole page view. Only those letters swap.
  display: "swap",
  // Next preloads local fonts by default; that would download this file on every page.
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-0127,U+012A-0167,U+016A-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  fallback: [],
});

const latin = localFont({
  weight: "200 800",
  style: "normal",
  // No metrics are published for this font, so Next cannot size a fallback.
  adjustFontFallback: false,
  src: "../fonts/AtkinsonHyperlegibleNext-latin-wght.woff2",
  display: "optional",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,U+0128-0129,U+0168-0169,U+0303",
    },
  ],
  fallback: [],
});

// Set on <html>; the theme reads --font-sans.
export const fontVars = {
  "--font-sans": `${latin.style.fontFamily}, ${latinExt.style.fontFamily}, system-ui, "Segoe UI", Roboto, Arial, sans-serif`,
} as React.CSSProperties;

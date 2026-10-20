import { SITE } from "@/lib/site";
import { docsDocument } from "@/lib/docs-chrome";
import { docsResponse } from "@/lib/docs-page";

// Static ReDoc served from this origin (copied from the pinned redoc package by
// scripts/vendor-docs.mjs), pointing at /openapi.json. The v3 standalone bundle is an ES module (it
// uses import.meta), so it needs type="module"; telemetry is off so no usage data leaves the page.
export const dynamic = "force-static";

// ReDoc's own palette fails WCAG AA in places (white method badges on pale greens and yellows, a grey
// caption at 2.7:1). Same hues, darker, so the page passes without losing its colour coding.
const THEME = JSON.stringify({
  colors: {
    text: { secondary: "#595b66" },
    http: {
      get: "#1b62c4",
      post: "#1a7f52",
      put: "#a85208",
      options: "#76560a",
      patch: "#0f766e",
      delete: "#bd2a20",
      basic: "#4b5563",
      link: "#4b5563",
      head: "#7a3fc0",
    },
    responses: {
      success: { color: "#1a7f52" },
      error: { color: "#bd2a20" },
      redirect: { color: "#8a5a00" },
      info: { color: "#1b62c4" },
    },
  },
});

// scroll-y-offset keeps ReDoc's sticky side menu and its jump links below the sticky site header.
// hide-logo drops the spec's own logo; the "API docs by" logo is handled in scripts/vendor-docs.mjs.
const HTML = docsDocument({
  path: "/redoc",
  title: `ReDoc | ${SITE.name}`,
  head: "",
  main: `<div class="docs-sheet" data-viewer="redoc"><redoc spec-url="/openapi.json" disable-telemetry="true" hide-logo="true" scroll-y-offset=".shell-header" theme='${THEME}'></redoc></div>`,
  scripts:
    '<script type="module" src="/docs-assets/redoc/redoc.standalone.js"></script>',
});

export async function GET(): Promise<Response> {
  return docsResponse(HTML);
}

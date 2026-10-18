import { docsResponse } from "@/lib/docs-page";

// Static ReDoc served from this origin (copied from the pinned redoc package by
// scripts/vendor-docs.mjs), pointing at /openapi.json. The v3 standalone bundle is an ES module (it
// uses import.meta), so it needs type="module"; telemetry is off so no usage data leaves the page.
export const dynamic = "force-static";

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clinic Booking API — ReDoc</title>
  </head>
  <body>
    <redoc spec-url="/openapi.json" disable-telemetry="true"></redoc>
    <script type="module" src="/docs-assets/redoc/redoc.standalone.js"></script>
  </body>
</html>`;

export async function GET(): Promise<Response> {
  return docsResponse(HTML);
}

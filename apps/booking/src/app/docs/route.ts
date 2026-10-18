import { docsResponse } from "@/lib/docs-page";

// Static Swagger UI served from this origin (public/docs-assets, copied from the pinned
// swagger-ui-dist by scripts/vendor-docs.mjs), pointing at the static /openapi.json.
// force-static: never reaches Cloud Run.
export const dynamic = "force-static";

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clinic Booking API — Swagger</title>
    <link rel="stylesheet" href="/docs-assets/swagger-ui/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs-assets/swagger-ui/swagger-ui-bundle.js"></script>
    <script src="/docs-assets/swagger-init.js"></script>
  </body>
</html>`;

export async function GET(): Promise<Response> {
  return docsResponse(HTML);
}

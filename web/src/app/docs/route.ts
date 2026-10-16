// Static Swagger UI, loaded from jsDelivr at a pinned version (same CDN FastAPI uses),
// pointing at the static /openapi.json. force-static: never reaches Cloud Run (§12.4).
export const dynamic = "force-static";

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clinic Booking API — Swagger</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.3/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.3/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });
    </script>
  </body>
</html>`;

export async function GET(): Promise<Response> {
  return new Response(HTML, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

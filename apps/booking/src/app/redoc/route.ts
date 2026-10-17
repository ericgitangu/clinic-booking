// Static ReDoc, loaded from jsDelivr at a pinned version, pointing at /openapi.json.
export const dynamic = "force-static";

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clinic Booking API — ReDoc</title>
  </head>
  <body>
    <redoc spec-url="/openapi.json"></redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc@3.0.1/bundles/redoc.standalone.js" integrity="sha384-j07qRKHNNmcwU1/Y1elJc7pDLHXP/QfbQXTtSkbOJ7uYGJikqAzsFVbY2zR9FqOT" crossorigin="anonymous"></script>
  </body>
</html>`;

export async function GET(): Promise<Response> {
  return new Response(HTML, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

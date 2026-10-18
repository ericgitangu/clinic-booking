/* global window, SwaggerUIBundle */
// Starts Swagger UI on the static contract. Kept as a file (not an inline script) so the docs pages
// can send a CSP with script-src 'self'. deepLinking makes /docs#/<tag>/<operationId> open that operation.
window.ui = SwaggerUIBundle({
  url: "/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
});

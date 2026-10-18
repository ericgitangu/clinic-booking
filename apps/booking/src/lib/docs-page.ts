// Shared by the /docs and /redoc routes. Both pages load only from this origin: the bundles are
// copied out of the pinned npm packages by scripts/vendor-docs.mjs into public/docs-assets/.
// The CSP is what keeps that true: no script, style, font or connection to any other host.
// 'unsafe-inline' is limited to styles because Swagger UI and ReDoc (styled-components) inject
// <style> at runtime; scripts stay 'self' only. ReDoc builds a worker from a blob: URL.
export const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function docsResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": DOCS_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

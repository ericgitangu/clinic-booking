import { SITE } from "@/lib/site";
import { docsDocument } from "@/lib/docs-chrome";
import { docsResponse } from "@/lib/docs-page";

// Static Swagger UI served from this origin (public/docs-assets, copied from the pinned
// swagger-ui-dist by scripts/vendor-docs.mjs), pointing at the static /openapi.json.
// force-static: never reaches Cloud Run.
export const dynamic = "force-static";

const HTML = docsDocument({
  path: "/docs",
  title: `API docs | ${SITE.name}`,
  head: '<link rel="stylesheet" href="/docs-assets/swagger-ui/swagger-ui.css" />',
  main: '<div class="docs-sheet" data-viewer="swagger"><div id="swagger-ui"></div></div>',
  scripts: `<script src="/docs-assets/swagger-ui/swagger-ui-bundle.js"></script>
    <script src="/docs-assets/swagger-init.js"></script>`,
});

export async function GET(): Promise<Response> {
  return docsResponse(HTML);
}

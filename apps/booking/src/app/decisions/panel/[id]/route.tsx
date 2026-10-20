import { render } from "@react-email/components";
import { PanelBody } from "@/components/architecture/panel-body";
import { TABS } from "@/content/architecture";
import { SITE } from "@/lib/site";

// One tab of /decisions as HTML, built once. The decisions page loads it when the tab is opened, so
// the page itself stays light. It is also a complete page: with scripts off, the tab links here and
// it reads as plain, unstyled HTML. It is not indexed on its own.
export const dynamic = "force-static";
export const dynamicParams = false;

const LAZY = TABS.filter((t) => t.id !== "decisions");

export function generateStaticParams() {
  return LAZY.map((t) => ({ id: t.id }));
}

const STYLE =
  "body{font:1rem/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem}" +
  "details{border:1px solid #888;border-radius:.5rem;margin:.5rem 0;padding:.5rem .75rem}" +
  "summary{cursor:pointer}pre{overflow-x:auto;padding:.5rem;background:#f0f0f0;color:#111}" +
  "table{border-collapse:collapse;display:block;overflow-x:auto}td,th{border:1px solid #888;padding:.25rem .5rem;text-align:left}" +
  "img{max-width:100%;height:auto}";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const tab = LAZY.find((t) => t.id === id);
  if (!tab) return new Response("Not found", { status: 404 });
  // Next refuses react-dom/server in app code. The email renderer is already a dependency and wraps
  // it, so it renders this server component to a string; its XHTML doctype is dropped.
  // TECH DEBT: a borrowed renderer. The clean fix is a build step that writes these fragments.
  const body = (
    await render(<PanelBody tabId={tab.id} label={tab.label} />, {
      pretty: false,
    })
  ).replace(/^<!DOCTYPE[^>]*>/i, "");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${tab.label} | ${SITE.name}</title><style>${STYLE}</style></head>` +
    `<body><p><a href="/decisions#${tab.id}">Back to the decisions page</a></p>` +
    `<main data-fragment>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    },
  });
}

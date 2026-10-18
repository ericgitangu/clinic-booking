import { activeHref } from "@clinic/ui/lib/nav";
import { resolveTrail } from "@clinic/ui/lib/shell-trail";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { FOOTER_COLUMNS } from "@/lib/footer-links";
import { SHELL_ROUTES } from "@/lib/shell-routes";
import { FOOTER_NOTICE, SITE } from "@/lib/site";

// /docs and /redoc are route handlers, not React pages, and they keep a CSP of script-src 'self'
// (lib/docs-page.ts). So they cannot use the React shell. This renders the same header, way back and
// footer as static HTML from the same link lists, and public/docs-assets/docs-shell.{css,js} (all
// same-origin) style and wire them. Debt, on purpose: the markup and CSS are a second copy of
// components/app-shell, kept in step by e2e/shell.spec.ts, which runs the same checks on these pages.

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function header(path: string): string {
  const active = activeHref(NAV_LINKS, path);
  const link = (l: (typeof NAV_LINKS)[number], cls: string) =>
    `<a class="${cls}" href="${esc(l.href)}"${l.href === active ? ' aria-current="page"' : ""}>${esc(l.label)}</a>`;
  return `<header class="shell-header" data-shell="header">
  <div class="shell-bar">
    <a class="shell-brand" href="/"><img src="/brand/idyllic-mark-80.webp" width="36" height="36" alt="" /><span>${esc(SITE.name)}</span></a>
    <div class="shell-right">
      <nav aria-label="Primary" class="shell-primary">${NAV_LINKS.filter(
        (l) => l.inline,
      )
        .map((l) => link(l, "shell-link"))
        .join("")}</nav>
      <button type="button" class="shell-icon-btn" id="shell-theme" aria-label="Switch theme"></button>
      <details class="shell-menu" id="shell-menu">
        <summary class="shell-icon-btn" aria-label="Menu"><svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></summary>
        <nav aria-label="Menu" class="shell-panel">${NAV_LINKS.map((l) => link(l, "shell-panel-link")).join("")}</nav>
      </details>
    </div>
  </div>
</header>`;
}

function trail(path: string): string {
  const { crumbs, parent } = resolveTrail(path, SHELL_ROUTES);
  if (!parent) return "";
  const items = crumbs
    .map((c, i) =>
      i === crumbs.length - 1
        ? `<li><span aria-current="page">${esc(c.label)}</span></li>`
        : `<li><a href="${esc(c.href)}">${esc(c.label)}</a></li><li aria-hidden="true" class="shell-sep">/</li>`,
    )
    .join("");
  return `<nav aria-label="Breadcrumb" class="shell-trail" data-shell="trail">
  <a class="shell-back" href="${esc(parent.href)}">Back to the app</a>
  <ol>${items}</ol>
</nav>`;
}

function footer(): string {
  const cols = FOOTER_COLUMNS.map(
    (c) =>
      `<nav aria-label="${esc(c.title)}"><h2>${esc(c.title)}</h2><ul>${c.links
        .map((l) =>
          l.external
            ? `<li><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}<span class="shell-sr"> (opens in a new tab)</span></a></li>`
            : `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`,
        )
        .join("")}</ul></nav>`,
  ).join("");
  return `<footer class="shell-footer" data-shell="footer">
  <div class="shell-footer-inner">
    <div class="shell-cols">${cols}</div>
    <p>${esc(FOOTER_NOTICE)}</p>
    <p>This site is protected by reCAPTCHA and the Google <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> apply.</p>
  </div>
</footer>`;
}

// One whole page: head extras and body content come from the caller, the frame from here.
export function docsDocument({
  path,
  title,
  head,
  main,
  scripts,
}: {
  path: string;
  title: string;
  head: string;
  main: string;
  scripts: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(title)}</title>
    <link rel="icon" href="/favicon.ico" />
    <link rel="stylesheet" href="/docs-assets/shell-tokens.css" />
    <link rel="stylesheet" href="/docs-assets/docs-shell.css" />
    <link rel="stylesheet" href="/docs-assets/docs-viewers.css" />
    <script src="/docs-assets/docs-shell.js"></script>
    ${head}
  </head>
  <body>
    <a class="shell-skip" href="#main">Skip to content</a>
    ${header(path)}
    ${trail(path)}
    <!-- A div, not <main>: Swagger UI and ReDoc each draw their own main landmark inside it. -->
    <div id="main" tabindex="-1">
      ${main}
    </div>
    ${footer()}
    ${scripts}
  </body>
</html>`;
}

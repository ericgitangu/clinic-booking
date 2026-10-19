// prebuild/predev: copy the Swagger UI and ReDoc browser bundles out of the pinned npm packages into
// public/docs-assets/, so /docs and /redoc load every byte from this origin (no CDN at runtime or in
// tests). The copies are generated, not committed (see .gitignore); the package.json pins are exact.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const out = resolve(here, "..", "public", "docs-assets");

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const version = (dir) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

const swagger = pkgDir("swagger-ui-dist");
const redoc = pkgDir("redoc");

const files = [
  [join(swagger, "swagger-ui.css"), "swagger-ui/swagger-ui.css"],
  [join(swagger, "swagger-ui-bundle.js"), "swagger-ui/swagger-ui-bundle.js"],
  [join(swagger, "LICENSE"), "swagger-ui/LICENSE"],
  [join(redoc, "bundles", "redoc.standalone.js"), "redoc/redoc.standalone.js"],
  [join(redoc, "LICENSE"), "redoc/LICENSE"],
];
for (const [from, to] of files) {
  const target = join(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
}

// ReDoc draws its "API docs by Redocly" link with a logo it fetches from cdn.redoc.ly, which the
// pages' CSP (img-src 'self' data: blob:) rightly blocks: one console error per load. The copy is
// patched to use an empty same-origin data: image instead, so the CSP stays as it is. The patch
// fails loudly if a ReDoc upgrade moves the URL, so it cannot silently stop applying.
const EMPTY_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";
const redocBundle = join(out, "redoc", "redoc.standalone.js");
const bundleText = readFileSync(redocBundle, "utf8");
const patched = bundleText.replace(
  /https:\/\/cdn\.redoc\.ly\/redoc\/logo-mini(?:-full)?\.svg/g,
  EMPTY_SVG,
);
if (patched === bundleText)
  throw new Error("vendor-docs: the ReDoc logo URL is gone; update the patch");
writeFileSync(redocBundle, patched);

// The site frame on these pages (docs-shell.css) reads the same colour tokens as the app, taken
// from the shared theme so there is one palette: every top-level :root and .dark block.
const theme = readFileSync(
  resolve(here, "..", "..", "..", "packages", "ui", "src", "theme.css"),
  "utf8",
);
const blocks = theme.match(/^(?::root|\.dark) \{[\s\S]*?^\}/gm) ?? [];
if (blocks.length < 3)
  throw new Error("vendor-docs: theme.css tokens not found");
writeFileSync(
  join(out, "shell-tokens.css"),
  `/* Copied by scripts/vendor-docs.mjs from packages/ui/src/theme.css; change the theme, not this file. */\n${blocks.join("\n\n")}\n`,
);

console.log(
  `vendor-docs: swagger-ui-dist@${version(swagger)}, redoc@${version(redoc)} -> ${out}`,
);

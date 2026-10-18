// prebuild/predev: copy the Swagger UI and ReDoc browser bundles out of the pinned npm packages into
// public/docs-assets/, so /docs and /redoc load every byte from this origin (no CDN at runtime or in
// tests). The copies are generated, not committed (see .gitignore); the package.json pins are exact.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
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
console.log(
  `vendor-docs: swagger-ui-dist@${version(swagger)}, redoc@${version(redoc)} -> ${out}`,
);

/* global process, console */
// After `next build`: gives each page that is built once the hashes of its own inline scripts in its
// Content-Security-Policy, so those pages need no 'unsafe-inline' (see packages/ui/src/lib/csp.ts).
// It rewrites the header list in .next/routes-manifest.json, which `next start` and the Vercel build
// output both read. Fails the build if a token is left unfilled or a page has no HTML.
// Usage: node csp-hashes.mjs <app dir>   (each app's "build" script runs it after `next build`)
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fillTokens, inlineScriptHashes } from "./csp-hashes-lib.mjs";

const app = resolve(process.argv[2] ?? ".");
const manifestPath = join(app, ".next", "routes-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const filled = fillTokens(manifest.headers, (page) =>
  inlineScriptHashes(
    readFileSync(join(app, ".next", "server", "app", `${page}.html`), "utf8"),
  ),
);
if (filled === 0)
  throw new Error("csp-hashes: no token found in routes-manifest.json headers");
const left = JSON.stringify(manifest.headers).includes(
  "__INLINE_SCRIPT_HASHES",
);
if (left)
  throw new Error("csp-hashes: an unfilled token is left in the headers");

writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(
  `csp-hashes: filled ${filled} page policies in routes-manifest.json`,
);

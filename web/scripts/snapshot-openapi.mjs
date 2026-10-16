// prebuild: snapshot the committed contract with servers rewritten to the proxy path, so the
// static /openapi.json never fetches from Cloud Run. The contract-drift check keeps it fresh.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "contracts", "openapi.json");
const target = resolve(here, "..", "src", "generated", "openapi.public.json");

const spec = JSON.parse(readFileSync(source, "utf8"));
spec.servers = [{ url: "/api" }];

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(spec, null, 2) + "\n");
console.log(`snapshot: ${target} (servers -> /api)`);

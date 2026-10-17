// The public view of the API contract. contracts/openapi.json describes everything the API
// serves, including the /internal endpoints that only the web apps' servers may call. The booking
// site publishes /openapi.json and /docs to anyone, so it must show the public endpoints only.
//
// Returns a copy: no /internal path, no operation tagged "admin", and only the schemas that the
// remaining paths still reach (an internal-only schema left behind would describe the admin API).

const INTERNAL_PREFIX = "/internal";
const INTERNAL_TAGS = new Set(["admin"]);

function refsIn(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) refsIn(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.add(value);
      else refsIn(value, found);
    }
  }
}

export function toPublicSpec(spec) {
  const out = structuredClone(spec);

  for (const path of Object.keys(out.paths ?? {})) {
    if (path === INTERNAL_PREFIX || path.startsWith(`${INTERNAL_PREFIX}/`)) {
      delete out.paths[path];
      continue;
    }
    for (const [method, op] of Object.entries(out.paths[path])) {
      if (op?.tags?.some((t) => INTERNAL_TAGS.has(t))) {
        delete out.paths[path][method];
      }
    }
    if (Object.keys(out.paths[path]).length === 0) delete out.paths[path];
  }

  if (Array.isArray(out.tags)) {
    out.tags = out.tags.filter((t) => !INTERNAL_TAGS.has(t.name));
    if (out.tags.length === 0) delete out.tags;
  }

  // Keep only the schemas reachable from what is left, following references between schemas.
  const schemas = out.components?.schemas;
  if (schemas) {
    const prefix = "#/components/schemas/";
    const reached = new Set();
    const queue = [];
    const seen = new Set();
    refsIn({ paths: out.paths, webhooks: out.webhooks }, seen);
    queue.push(...seen);
    while (queue.length > 0) {
      const ref = queue.pop();
      if (!ref.startsWith(prefix) || reached.has(ref)) continue;
      reached.add(ref);
      const next = new Set();
      refsIn(schemas[ref.slice(prefix.length)], next);
      queue.push(...next);
    }
    for (const name of Object.keys(schemas)) {
      if (!reached.has(prefix + name)) delete schemas[name];
    }
  }
  return out;
}

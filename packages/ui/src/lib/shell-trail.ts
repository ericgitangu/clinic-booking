// Where a page sits in the site, so every page past the root can say "Back to <parent>" with a real
// link. Pure functions, no React: each app lists its routes once (src/lib/shell-routes.ts) and the
// shell resolves the current path against that list.

// `pattern` uses ":name" for one dynamic segment. `parent` is another route's pattern; names it
// shares with this route are filled in from the current path, so "/book/:doctorId/details" can
// point at "/book/:doctorId". A route without a parent is a root: it gets no back link.
export type ShellRoute = {
  pattern: string;
  label: string;
  // What "Back to ..." says when this route is the parent, in sentence case ("my appointments").
  // Without it, the label with its first letter lowercased.
  backLabel?: string;
  parent?: string;
};

export type ShellRoutes = {
  routes: readonly ShellRoute[];
  // Where an unknown path (the 404 page) goes back to, and what the last crumb says there.
  fallbackParent: string;
  unknownLabel: string;
};

export type Crumb = { href: string; label: string; backLabel: string };

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const backOf = (r: ShellRoute) => r.backLabel ?? lowerFirst(r.label);

export type Trail = {
  // Root first, the current page last. A root page has a single crumb.
  crumbs: readonly Crumb[];
  // The crumb before the current one; null on a root page.
  parent: Crumb | null;
};

const MAX_DEPTH = 8;

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

// The path without query, hash or a trailing slash. "/" stays "/".
export function normalizePath(raw: string): string {
  const bare = raw.split(/[?#]/, 1)[0] ?? "";
  const trimmed = bare.replace(/\/+$/, "");
  return trimmed === ""
    ? "/"
    : trimmed.startsWith("/")
      ? trimmed
      : `/${trimmed}`;
}

// The ":name" values if `path` fits `pattern`, else null.
export function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const want = segments(pattern);
  const have = segments(path);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const h = have[i] as string;
    if (w.startsWith(":")) params[w.slice(1)] = h;
    else if (w !== h) return null;
  }
  return params;
}

// A pattern with its ":name" parts replaced; null when a name has no value.
export function fillPattern(
  pattern: string,
  params: Record<string, string>,
): string | null {
  const out: string[] = [];
  for (const seg of segments(pattern)) {
    if (!seg.startsWith(":")) {
      out.push(seg);
      continue;
    }
    const value = params[seg.slice(1)];
    if (value === undefined) return null;
    out.push(value);
  }
  return `/${out.join("/")}`;
}

function findRoute(config: ShellRoutes, path: string) {
  // The pattern with the fewest dynamic segments wins, so "/book/confirmed" beats "/book/:doctorId".
  let best: {
    route: ShellRoute;
    params: Record<string, string>;
    dyn: number;
  } | null = null;
  for (const route of config.routes) {
    const params = matchPattern(route.pattern, path);
    if (!params) continue;
    const dyn = Object.keys(params).length;
    if (!best || dyn < best.dyn) best = { route, params, dyn };
  }
  return best;
}

export function resolveTrail(
  rawPath: string | null,
  config: ShellRoutes,
): Trail {
  const path = normalizePath(rawPath ?? "/");
  const hit = findRoute(config, path);

  if (!hit) {
    const up = findRoute(config, config.fallbackParent);
    const above = up
      ? chain(config, up.route, up.params, config.fallbackParent)
      : [{ href: config.fallbackParent, label: "Home", backLabel: "home" }];
    return {
      crumbs: [
        ...above,
        {
          href: path,
          label: config.unknownLabel,
          backLabel: lowerFirst(config.unknownLabel),
        },
      ],
      parent: above.at(-1) ?? null,
    };
  }

  const crumbs = chain(config, hit.route, hit.params, path);
  return { crumbs, parent: crumbs.length > 1 ? (crumbs.at(-2) ?? null) : null };
}

// Root first, ending with `route` at `href`.
function chain(
  config: ShellRoutes,
  route: ShellRoute,
  params: Record<string, string>,
  href: string,
): Crumb[] {
  const out: Crumb[] = [{ href, label: route.label, backLabel: backOf(route) }];
  const seen = new Set<string>([route.pattern]);
  let current = route;
  for (let depth = 0; depth < MAX_DEPTH && current.parent; depth++) {
    if (seen.has(current.parent)) break;
    const next = config.routes.find((r) => r.pattern === current.parent);
    const to = next && fillPattern(next.pattern, params);
    if (!next || !to) break;
    seen.add(next.pattern);
    out.unshift({ href: to, label: next.label, backLabel: backOf(next) });
    current = next;
  }
  return out;
}

// Problems with a route list: a parent that is not a route, a parent that needs a name the child
// does not have, a loop. Used by each app's unit test so a typo fails in CI, not on a phone.
export function checkRoutes(config: ShellRoutes): string[] {
  const problems: string[] = [];
  const byPattern = new Map(config.routes.map((r) => [r.pattern, r]));
  if (byPattern.size !== config.routes.length)
    problems.push("duplicate pattern");
  if (!findRoute(config, config.fallbackParent))
    problems.push(`fallbackParent ${config.fallbackParent} is not a route`);
  for (const r of config.routes) {
    if (!r.parent) continue;
    const parent = byPattern.get(r.parent);
    if (!parent) {
      problems.push(`${r.pattern}: parent ${r.parent} is not a route`);
      continue;
    }
    const mine = new Set(
      segments(r.pattern)
        .filter((s) => s.startsWith(":"))
        .map((s) => s.slice(1)),
    );
    for (const s of segments(parent.pattern))
      if (s.startsWith(":") && !mine.has(s.slice(1)))
        problems.push(`${r.pattern}: parent needs ${s} which the child lacks`);
    const seen = new Set([r.pattern]);
    for (
      let p: ShellRoute | undefined = parent;
      p;
      p = p.parent ? byPattern.get(p.parent) : undefined
    ) {
      if (seen.has(p.pattern)) {
        problems.push(`${r.pattern}: parent chain loops`);
        break;
      }
      seen.add(p.pattern);
    }
  }
  return problems;
}

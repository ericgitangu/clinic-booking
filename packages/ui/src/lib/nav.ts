// A link in the header and the phone menu. Plain anchors: some targets are route handlers, not pages.
// `inline` links also show in the bar on wider screens; the rest are in the phone menu only.
export type NavLink = { href: string; label: string; inline?: boolean };

// The link that matches the current page: the longest href that is the path or one of its ancestors
// ("/book" on "/book/abc/details"). Null when none match, e.g. on a 404.
export function activeHref(
  links: readonly NavLink[],
  pathname: string | null,
): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const { href } of links) {
    const path = href.split(/[?#]/, 1)[0] ?? href;
    if (!path.startsWith("/")) continue;
    const hit =
      path === "/"
        ? pathname === "/"
        : pathname === path || pathname.startsWith(`${path}/`);
    if (hit && (best === null || path.length > best.length)) best = path;
  }
  return best;
}

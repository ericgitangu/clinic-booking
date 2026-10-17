// A link in the header and the phone menu. Plain anchors: some targets are route handlers, not pages.
// `inline` links also show in the bar on wider screens; the rest are in the phone menu only.
export type NavLink = { href: string; label: string; inline?: boolean };

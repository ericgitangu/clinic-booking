// Where the header and the phone menu point. "inline" links also show in the bar on wider screens;
// the rest live in the phone menu. Some targets are route handlers, not pages, so these are plain anchors.
import type { NavLink } from "@clinic/ui/lib/nav";

export const NAV_LINKS: readonly NavLink[] = [
  { href: "/book", label: "Book a visit", inline: true },
  { href: "/appointments", label: "My appointments", inline: true },
  { href: "/decisions", label: "Decisions", inline: true },
  { href: "/docs", label: "API docs" },
  { href: "/redoc", label: "ReDoc" },
  { href: "/openapi.json", label: "OpenAPI contract" },
];

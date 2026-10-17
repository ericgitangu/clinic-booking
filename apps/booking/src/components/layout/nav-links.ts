// Where the header and the phone menu point. Plain anchors: these are route handlers, not pages.
export const NAV_LINKS = [
  { href: "/docs", label: "API docs" },
  { href: "/redoc", label: "ReDoc" },
  { href: "/openapi.json", label: "OpenAPI contract" },
] as const;

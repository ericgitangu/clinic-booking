// Facts about the admin app. The patient app has its own copy: a different name, host and links.
export const SITE = {
  name: "Idyllic Clinic Admin",
  shortName: "Idyllic Admin",
  description: "Staff dashboard for Idyllic Clinic Admin.",
  url: "https://clinic-admin.ericgitangu.com",
  bookingUrl: "https://clinic.ericgitangu.com",
  locale: "en_KE",
} as const;

// Browser UI colours: the page background in each theme (the same two the patient app uses).
export const THEME_COLORS = { light: "#f4f8fc", dark: "#0a1130" } as const;

export const FOOTER_NOTICE =
  "© 2026 Eric Gitangu. A take-home assessment for Savannah Informatics, not a live medical service.";

export const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard", inline: true },
] as const;

// Owners also see where access is managed. Hiding the link is only a convenience: the page and
// the API check the role themselves.
export const ACCESS_LINK = {
  href: "/access",
  label: "Access",
  inline: true,
} as const;

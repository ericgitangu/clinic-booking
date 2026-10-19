// One place for the facts every page, icon, sitemap and manifest repeats.
export const SITE = {
  name: "Idyllic Clinic",
  shortName: "Idyllic",
  description:
    "Find a doctor, see free slots in Nairobi time, book a visit, and cancel or reschedule when plans change.",
  url: "https://clinic.ericgitangu.com",
  locale: "en_KE",
} as const;

export const FOOTER_NOTICE =
  "© 2026 Eric Gitangu. A take-home assessment for Savannah Informatics, not a live medical service. Times are shown in East Africa Time (UTC+3).";

export const CONTACT_EMAIL = "developer.ericgitangu@gmail.com";

// Browser UI colours: the page background in each theme.
export const THEME_COLORS = { light: "#f4f8fc", dark: "#0a1130" } as const;

// Pages crawlers may index. Anything not listed (admin, auth, cron) is also disallowed in robots.
export const PUBLIC_PATHS = [
  "/",
  "/book",
  "/privacy",
  "/terms",
  "/about",
  "/data",
  "/docs",
  "/redoc",
  "/openapi.json",
] as const;

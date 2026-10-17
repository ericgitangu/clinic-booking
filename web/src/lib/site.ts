// One place for the facts every page, icon, sitemap and manifest repeats.
export const SITE = {
  name: "Idyllic Clinic Booking",
  shortName: "Idyllic",
  description:
    "Find a doctor, see free slots in Nairobi time, book a visit, and cancel or reschedule when plans change.",
  url: "https://sil-clinic-booking.vercel.app",
  locale: "en_KE",
} as const;

// Browser UI colours: the page background in each theme.
export const THEME_COLORS = { light: "#f4f8fc", dark: "#0a1130" } as const;

// Pages crawlers may index. Anything not listed (admin, auth, cron) is also disallowed in robots.
export const PUBLIC_PATHS = ["/", "/docs", "/redoc"] as const;

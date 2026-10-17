// Facts about the admin app. The patient app has its own copy: a different name, host and links.
export const SITE = {
  name: "Idyllic Clinic Admin",
  description: "Staff dashboard for Idyllic Clinic Booking.",
  url: "https://clinic-admin.ericgitangu.com",
  bookingUrl: "https://clinic.ericgitangu.com",
} as const;

export const FOOTER_NOTICE =
  "© 2026 Eric Gitangu. A take-home assessment for Savannah Informatics, not a live medical service.";

export const NAV_LINKS = [{ href: "/dashboard", label: "Dashboard" }] as const;

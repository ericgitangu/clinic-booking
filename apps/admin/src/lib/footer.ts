import type { FooterColumn } from "@clinic/ui/lib/footer";
import { SITE } from "@/lib/site";

export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    title: "Idyllic Clinic Admin",
    links: [
      {
        label: "Patient site",
        href: SITE.bookingUrl,
        external: true,
        icon: "calendar",
      },
      {
        label: "Privacy",
        href: `${SITE.bookingUrl}/privacy`,
        external: true,
        icon: "scale",
      },
      {
        label: "Terms",
        href: `${SITE.bookingUrl}/terms`,
        external: true,
        icon: "scale",
      },
    ],
  },
];
